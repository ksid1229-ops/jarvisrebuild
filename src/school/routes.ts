/**
 * School HTTP surface: the 4 routes the School Helper app dials.
 * POST /school/pairing/start, /school/pairing/prove, /school/pairing/status,
 * POST /school/observations. Canonical bodies; the signed routes carry the
 * envelope as compact JSON in the x-jarvis-signed-request header (the app's
 * transport already sends exactly this). Pairing approval goes through the
 * agent as a spoken 6-digit code.
 */
import type { D1Db } from "../persistence/d1.js";
import {
  parseSchoolBatch,
  SCHOOL_PAIR_TTL_MS,
  verifyCollectorRequest,
  type CollectorKey,
  type SchoolObservationBatch,
} from "./collector-protocol.js";
import {
  decodeCanonicalBase64,
  decodeCanonicalRawBody,
  encodeBase64Url,
  type JsonValue,
} from "./signed-request.js";
import { CollectorKeys } from "./collector-keys.js";
import { EvidenceStore } from "./evidence-store.js";

export const COLLECTOR_ENVELOPE_HEADER = "x-jarvis-signed-request";

export interface SchoolRouteDeps {
  db: D1Db;
  ownerId: string;
  nowMs: () => number;
}

export interface SchoolRouteResult {
  status: number;
  body: unknown;
  /** Present only on a fresh pairing start: the DO must wake the agent with this. */
  pairing?: { code: string; deviceLabel: string; collectorId: string; expiresAt: string };
}

function err(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function fail(status: number, code: string, message: string): SchoolRouteResult {
  return { status, body: err(code, message) };
}

function newPairingCode(): string {
  const digits = crypto.getRandomValues(new Uint8Array(6));
  const part = (i: number): string =>
    `${(digits[i] ?? 0) % 10}${(digits[i + 1] ?? 0) % 10}${(digits[i + 2] ?? 0) % 10}`;
  return `${part(0)}-${part(3)}`;
}

function isSafeLabel(label: unknown): label is string {
  return typeof label === "string" && /^[^\x00-\x1F\x7F]{1,64}$/.test(label);
}

function rawBytes(rawBody: string): Uint8Array {
  return new TextEncoder().encode(rawBody);
}

/** Map verifier throws onto HTTP. The peek confers no authority; verify still decides. */
function verifyFailure(error: unknown): SchoolRouteResult {
  const code = error instanceof Error ? error.message : "school_signature_invalid";
  switch (code) {
    case "school_key_inactive":
      return fail(403, code, "collector key is not active");
    case "school_nonce_refused":
      return fail(409, code, "nonce already used");
    case "school_body_hash_invalid":
      return fail(400, code, "body does not match envelope hash");
    case "school_authority_invalid":
    case "school_signature_expired":
    case "school_signature_invalid":
      return fail(401, code, "signature check failed");
    default:
      return fail(401, "school_signature_invalid", "signature check failed");
  }
}

function peekEnvelope(headers: Headers): { header: unknown; deviceId: string } | SchoolRouteResult {
  const raw = headers.get(COLLECTOR_ENVELOPE_HEADER);
  if (!raw) return fail(401, "school_authority_invalid", "missing collector envelope");
  let header: unknown;
  try {
    header = JSON.parse(raw) as unknown;
  } catch {
    return fail(401, "school_authority_invalid", "collector envelope is not JSON");
  }
  const deviceId =
    typeof header === "object" && header !== null
      ? (header as Record<string, unknown>).deviceId
      : undefined;
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    return fail(401, "school_authority_invalid", "collector envelope names no device");
  }
  return { header, deviceId };
}

type Peeked = { header: unknown; deviceId: string } | { header: unknown; key: CollectorKey };

function isSchoolRouteResult(v: Peeked | SchoolRouteResult): v is SchoolRouteResult {
  return typeof (v as SchoolRouteResult).status === "number";
}

export async function handleSchoolRequest(
  method: string,
  path: string,
  headers: Headers,
  rawBody: string,
  deps: SchoolRouteDeps,
): Promise<SchoolRouteResult> {
  if (method !== "POST") {
    return fail(405, "method_not_allowed", "school routes accept POST only");
  }
  if (path === "/school/pairing/start") return handleStart(rawBody, deps);
  if (path === "/school/pairing/prove") return handleProve(headers, rawBody, path, deps);
  if (path === "/school/pairing/status") return handleStatus(headers, rawBody, path, deps);
  if (path === "/school/observations") return handleObservations(headers, rawBody, path, deps);
  return fail(404, "not_found", `unknown school route ${path}`);
}

async function handleStart(rawBody: string, deps: SchoolRouteDeps): Promise<SchoolRouteResult> {
  let body: JsonValue;
  try {
    body = decodeCanonicalRawBody(rawBytes(rawBody));
  } catch (error) {
    return fail(400, "bad_request", error instanceof Error ? error.message : "bad body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(400, "bad_request", "start body must be an object");
  }
  const rec = body as Record<string, unknown>;
  if (typeof rec.publicKeyBase64 !== "string") {
    return fail(400, "bad_request", "publicKeyBase64 must be a string");
  }
  try {
    decodeCanonicalBase64(rec.publicKeyBase64, 32);
  } catch {
    return fail(400, "bad_request", "publicKeyBase64 must be canonical base64 of 32 bytes");
  }
  if (!isSafeLabel(rec.deviceLabel)) {
    return fail(400, "bad_request", "deviceLabel must be 1-64 printable characters");
  }

  const now = deps.nowMs();
  const expiresAt = new Date(now + SCHOOL_PAIR_TTL_MS).toISOString();
  const collectorId = `col_${crypto.randomUUID()}`;
  const challenge = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const code = newPairingCode();
  const keys = new CollectorKeys(deps.db);
  await keys.createPending({
    collector_id: collectorId,
    principal_id: deps.ownerId,
    public_key_base64: rec.publicKeyBase64,
    device_label: rec.deviceLabel,
    status: "pending",
    challenge,
    pairing_code: code,
    expires_at: expiresAt,
    decision_id: null,
  });

  return {
    status: 200,
    body: { collectorId, principalId: deps.ownerId, challenge, code, expiresAt },
    pairing: { code, deviceLabel: rec.deviceLabel, collectorId, expiresAt },
  };
}

/** Route a prove/status call by live key status. Unknown and revoked keys stop here. */
async function peekKey(
  headers: Headers, deps: SchoolRouteDeps,
): Promise<{ header: unknown; key: CollectorKey } | SchoolRouteResult> {
  const peeked = peekEnvelope(headers);
  if (isSchoolRouteResult(peeked)) return peeked;
  const key = await new CollectorKeys(deps.db).get(peeked.deviceId);
  if (!key) return fail(403, "school_key_inactive", "unknown collector");
  if (key.status === "revoked") return fail(403, "school_key_revoked", "collector key is revoked");
  if (key.status === "pending" && Date.parse(key.expires_at) <= deps.nowMs()) {
    return fail(410, "pairing_expired", "pairing expired; start again");
  }
  return { header: peeked.header, key };
}

async function handleProve(
  headers: Headers, rawBody: string, path: string, deps: SchoolRouteDeps,
): Promise<SchoolRouteResult> {
  const peeked = await peekKey(headers, deps);
  if (isSchoolRouteResult(peeked)) return peeked;
  let verified: { body: JsonValue };
  try {
    verified = await verifyCollectorRequest(
      deps.db, deps.ownerId, peeked.header, path, rawBytes(rawBody),
      new Date(deps.nowMs()), peeked.key.status as "pending" | "active",
    );
  } catch (error) {
    return verifyFailure(error);
  }
  const body = verified.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(400, "bad_request", "prove body must be an object");
  }
  const challenge = (body as Record<string, unknown>).challenge;
  if (typeof challenge !== "string" || challenge !== peeked.key.challenge) {
    return fail(401, "bad_challenge", "challenge mismatch");
  }
  return { status: 200, body: { ok: true } };
}

async function handleStatus(
  headers: Headers, rawBody: string, path: string, deps: SchoolRouteDeps,
): Promise<SchoolRouteResult> {
  const peeked = await peekKey(headers, deps);
  if (isSchoolRouteResult(peeked)) return peeked;
  try {
    await verifyCollectorRequest(
      deps.db, deps.ownerId, peeked.header, path, rawBytes(rawBody),
      new Date(deps.nowMs()), peeked.key.status as "pending" | "active",
    );
  } catch (error) {
    return verifyFailure(error);
  }
  return { status: 200, body: { status: peeked.key.status } };
}

async function handleObservations(
  headers: Headers, rawBody: string, path: string, deps: SchoolRouteDeps,
): Promise<SchoolRouteResult> {
  const peeked = peekEnvelope(headers);
  if (isSchoolRouteResult(peeked)) return peeked;
  const key = await new CollectorKeys(deps.db).get(peeked.deviceId);
  // Pending keys must not observe: the reference answers school_key_inactive.
  if (!key || key.status !== "active") {
    return fail(403, "school_key_inactive", "collector key is not active");
  }
  let verified: { body: JsonValue };
  try {
    verified = await verifyCollectorRequest(
      deps.db, deps.ownerId, peeked.header, path, rawBytes(rawBody),
      new Date(deps.nowMs()), "active",
    );
  } catch (error) {
    return verifyFailure(error);
  }

  const store = new EvidenceStore(deps.db);
  const now = new Date(deps.nowMs());
  const receivedAt = now.toISOString();
  const batchId = `batch_${crypto.randomUUID()}`;
  let batch: SchoolObservationBatch;
  try {
    batch = parseSchoolBatch(verified.body, now);
  } catch (error) {
    await store.insert({
      batchId, host: "unknown", readId: `failed_${batchId}`, startedAt: receivedAt,
      courseId: null, courseName: null, enrollmentComplete: false,
      bodyJson: rawBody, outcome: "failed",
    }, receivedAt);
    const message = error instanceof Error ? error.message : "invalid batch";
    return { status: 400, body: { ...err("invalid_batch", message), batchId } };
  }

  await store.insert({
    batchId,
    host: batch.host,
    readId: batch.readId,
    startedAt: batch.startedAt,
    courseId: batch.course?.id ?? null,
    courseName: batch.course?.name ?? null,
    enrollmentComplete: batch.enrollmentComplete,
    bodyJson: rawBody,
    outcome: "good",
  }, receivedAt);
  return { status: 200, body: { batchId, outcome: "good" } };
}
