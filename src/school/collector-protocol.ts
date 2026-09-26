/**
 * The school collector protocol: the receiver side of what School Helper
 * pushes. Ported from the proven reference (stremysid/jarvis
 * apps/cloud-gateway/src/school/collector-protocol.ts, read at commit
 * 0c56920). Error strings are kept identical so the app's link log and any
 * future debugging read the same in both systems.
 *
 * One deliberate simplification vs the reference: the reference joins a
 * `principals` table (multi-principal system). This rebuild is single-owner —
 * the owner id comes from env (`OWNER_CHAT_ID`-family config) and the
 * `principal_id` on the key must equal it. Recorded in PROGRESS.md.
 */

import {
  decodeCanonicalBase64,
  decodeCanonicalRawBody,
  sha256Hex,
  signatureText,
  validateRequest,
  type JsonValue,
} from "./signed-request.js";

export const SCHOOL_AUDIENCE = "jarvis-school-collector";
export const SCHOOL_HOST = "ldsb.elearningontario.ca";
export const SCHOOL_HOSTS = [SCHOOL_HOST, "durham.elearningontario.ca"] as const;
export type SchoolHost = (typeof SCHOOL_HOSTS)[number];
export const SCHOOL_BODY_LIMIT = 65_536;
export const SCHOOL_PAIR_ORIGIN = "school-collector-pair";
export const SCHOOL_PAIR_TTL_MS = 10 * 60_000;
const SIGNATURE_SKEW_MS = 300_000;

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("school_object_invalid");
  }
  return value as Record<string, unknown>;
}

export function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const result = record(value);
  if (Object.keys(result).sort().join(",") !== [...fields].sort().join(",")) {
    throw new Error("school_fields_invalid");
  }
  return result;
}

export function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(label);
  return value;
}

const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function requireInstant(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !UTC_MILLISECONDS.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(label);
  }
  return value;
}

export function identifier(value: unknown): string {
  const result = requireText(value, "school_id", 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error("school_id_invalid");
  return result;
}

export interface RouteEvidence {
  readonly route: string;
  readonly status: number;
  readonly fetchedAt: string;
  readonly complete: boolean;
  readonly body: JsonValue;
}

export interface SchoolBatch {
  readonly schemaVersion: "1.0";
  readonly host: SchoolHost;
  readonly readId: string;
  readonly startedAt: string;
  readonly courseIds: readonly string[];
  readonly enrollmentComplete: boolean;
  readonly course: { readonly id: string; readonly name: string };
  readonly routes: readonly RouteEvidence[];
}

export interface SchoolHostFailureBatch
  extends Omit<SchoolBatch, "course" | "courseIds" | "enrollmentComplete"> {
  readonly course: null;
  readonly courseIds: readonly [];
  readonly enrollmentComplete: false;
}

export type SchoolObservationBatch = SchoolBatch | SchoolHostFailureBatch;

export function parseSchoolBatch(value: unknown, now: Date): SchoolObservationBatch {
  const root = exact(value, [
    "schemaVersion",
    "host",
    "readId",
    "startedAt",
    "courseIds",
    "enrollmentComplete",
    "course",
    "routes",
  ]);
  if (root.schemaVersion !== "1.0" || !SCHOOL_HOSTS.includes(root.host as SchoolHost)) {
    throw new Error("school_source_invalid");
  }
  identifier(root.readId);
  const startedAt = requireInstant(root.startedAt as string, "school_started_at");
  if (Date.parse(startedAt) > now.getTime()) throw new Error("school_time_future");
  const hostFailure = root.course === null;
  const course = hostFailure ? null : exact(root.course, ["id", "name"]);
  const courseId = course === null ? null : identifier(course.id);
  if (course !== null) requireText(course.name, "school_course_name", 512);
  if (
    !Array.isArray(root.courseIds) ||
    root.courseIds.length > 128 ||
    root.courseIds.some((id) => identifier(id) !== id) ||
    new Set(root.courseIds).size !== root.courseIds.length ||
    (hostFailure
      ? root.courseIds.length !== 0 || root.enrollmentComplete !== false
      : !root.courseIds.includes(courseId)) ||
    typeof root.enrollmentComplete !== "boolean"
  ) {
    throw new Error("school_manifest_invalid");
  }
  if (
    !Array.isArray(root.routes) ||
    root.routes.length > 256 ||
    (hostFailure && root.routes.length === 0)
  ) {
    throw new Error("school_routes_invalid");
  }
  const prefix = `/d2l/api/le/1.82/${courseId}/`;
  const myItemsRoute = `/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=${courseId}`;
  const seen = new Set<string>();
  for (const value of root.routes) {
    const route = exact(value, ["route", "status", "fetchedAt", "complete", "body"]);
    if (
      typeof route.route !== "string" ||
      !route.route.startsWith("/d2l/api/") ||
      route.route.includes("#")
    ) {
      throw new Error("school_route_invalid");
    }
    const url = new URL(route.route, `https://${root.host}`);
    const orgUnitIds = url.searchParams.getAll("orgUnitIdsCSV");
    const isMyItems =
      url.pathname === myItemsRoute.split("?")[0] &&
      orgUnitIds.length === 1 &&
      orgUnitIds[0] === courseId;
    const isQuizzes = url.pathname === prefix + "quizzes/";
    const isEnrollments = url.pathname === "/d2l/api/lp/1.43/enrollments/myenrollments/";
    const isEnrollmentBookmark =
      hostFailure && isEnrollments && url.searchParams.size === 1 && url.searchParams.has("bookmark");
    const allowed = hostFailure
      ? ["/d2l/api/versions/", "/d2l/api/lp/1.43/enrollments/myenrollments/"].includes(url.pathname)
      : isMyItems ||
        (url.pathname.startsWith(prefix) &&
          /^(dropbox\/folders\/|dropbox\/folders\/[a-zA-Z0-9_-]+\/submissions\/mysubmissions\/|content\/toc|grades\/values\/myGradeValues\/|grades\/|news\/|quizzes\/)$/.test(
            url.pathname.slice(prefix.length),
          ));
    if (
      route.route !== url.pathname + url.search ||
      !allowed ||
      (url.search !== "" && !isMyItems && !isQuizzes && !isEnrollmentBookmark) ||
      seen.has(route.route)
    ) {
      throw new Error("school_route_invalid");
    }
    seen.add(route.route);
    if (
      !Number.isInteger(route.status) ||
      !(route.status === 0 || (Number(route.status) >= 100 && Number(route.status) <= 599)) ||
      typeof route.complete !== "boolean"
    ) {
      throw new Error("school_route_status_invalid");
    }
    const at = requireInstant(route.fetchedAt as string, "school_fetched_at");
    if (at < startedAt || Date.parse(at) > now.getTime()) throw new Error("school_time_invalid");
  }
  return value as SchoolObservationBatch;
}

export interface CollectorKey {
  collector_id: string;
  principal_id: string;
  public_key_base64: string;
  device_label: string;
  status: "pending" | "active" | "revoked";
  challenge: string;
  pairing_code: string;
  expires_at: string;
  decision_id: string | null;
}

/**
 * The D1 surface this protocol needs. Production passes the real D1Database
 * binding; tests pass a fake. Kept minimal on purpose.
 */
export interface CollectorDb {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
}

/**
 * Copy bytes into a fresh ArrayBuffer-backed view. The DOM lib types
 * BufferSource as ArrayBuffer-backed, while a decoded Uint8Array's buffer is
 * ArrayBufferLike — the copy keeps tsc and every runtime happy.
 */
function asArrayBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/** The shared wire parser confers no authority. Only this registry does. */
export async function verifyCollectorRequest(
  database: CollectorDb,
  owner: string,
  header: unknown,
  path: string,
  raw: Uint8Array,
  now: Date,
  status: "pending" | "active",
): Promise<{ key: CollectorKey; body: JsonValue; bodyHash: string }> {
  const envelope = validateRequest(header);
  if (envelope.audience !== SCHOOL_AUDIENCE || envelope.principalId !== owner) {
    throw new Error("school_authority_invalid");
  }
  if (Math.abs(now.getTime() - Date.parse(envelope.issuedAt)) >= SIGNATURE_SKEW_MS) {
    throw new Error("school_signature_expired");
  }
  const key = await database
    .prepare(
      `SELECT * FROM school_collector_keys
       WHERE collector_id = ? AND principal_id = ? AND status = ?
         AND (status = 'active' OR expires_at > ?)`,
    )
    .bind(envelope.deviceId, owner, status, now.toISOString())
    .first<CollectorKey>();
  if (key === null) throw new Error("school_key_inactive");
  const publicKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(decodeCanonicalBase64(key.public_key_base64, 32)),
    "Ed25519",
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      asArrayBuffer(decodeCanonicalBase64(envelope.signatureBase64, 64)),
      signatureText(envelope, "POST", path),
    ))
  ) {
    throw new Error("school_signature_invalid");
  }
  if ((await sha256Hex(raw)) !== envelope.bodyHash) throw new Error("school_body_hash_invalid");
  const body = decodeCanonicalRawBody(raw);
  // Recheck status inside the insert so a revoke racing signature verification wins.
  const inserted = await database
    .prepare(
      `INSERT INTO school_collector_nonces (collector_id, nonce, used_at)
       SELECT collector_id, ?, ? FROM school_collector_keys WHERE collector_id = ? AND status = ?
       ON CONFLICT DO NOTHING RETURNING collector_id`,
    )
    .bind(envelope.nonce, now.toISOString(), key.collector_id, status)
    .first();
  if (inserted === null) throw new Error("school_nonce_refused");
  return { key, body, bodyHash: envelope.bodyHash };
}
