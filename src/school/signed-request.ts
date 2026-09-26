/**
 * Signed-request verification for dial-out devices (the School Helper
 * extension). Ported from the proven reference (stremysid/jarvis
 * apps/cloud-gateway/src/sync/signed-request.ts, read at commit 0c56920).
 *
 * The contract, exactly as the reference enforces it:
 *  - The `x-jarvis-signed-request` header carries exactly 8 fields.
 *  - `issuedAt` is an ISO-8601 UTC string with milliseconds — NOT an epoch
 *    number. (The school app initially sent a number; that never verifies.
 *    See PROGRESS.md. The app fix makes it send ISO strings.)
 *  - The signature covers "POST\\n<path>\\n<deviceId>\\n<principalId>\\n
 *    <audience>\\n<issuedAt>\\n<nonce>\\n<bodyHash>".
 *  - `bodyHash` is SHA-256 over the EXACT body bytes, and the body must
 *    re-canonicalize to those same bytes — a re-serialized body is refused.
 */

import { canonicalBytes } from "./canonical.js";

export interface SignedRequestV1 {
  readonly schemaVersion: "1.0";
  readonly deviceId: string;
  readonly principalId: string;
  readonly audience: string;
  readonly issuedAt: string;
  readonly nonce: string;
  readonly bodyHash: string;
  readonly signatureBase64: string;
}

const REQUEST_FIELDS = [
  "schemaVersion",
  "deviceId",
  "principalId",
  "audience",
  "issuedAt",
  "nonce",
  "bodyHash",
  "signatureBase64",
] as const;
const REQUEST_FIELD_SET = new Set<string>(REQUEST_FIELDS);
const SHA256 = /^[a-f0-9]{64}$/;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAXIMUM_SIGNED_BODY_BYTES = 65_536;
const MAXIMUM_SIGNED_BODY_DEPTH = 32;
const MAXIMUM_SIGNED_BODY_STRUCTURE_ITEMS = 4_096;
const encoder = new TextEncoder();

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function byteEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function isSafeAtom(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    isWellFormedString(value) &&
    value === value.normalize("NFC") &&
    !value.includes("\n") &&
    !value.includes("\r") &&
    encoder.encode(value).byteLength <= maximumBytes
  );
}

function parseTimestamp(value: unknown): Date | null {
  if (!isSafeAtom(value, 32) || !UTC_MILLISECONDS.test(value)) return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value ? parsed : null;
}

export function decodeCanonicalBase64(
  value: unknown,
  byteLength: number,
  error = "base64_invalid",
): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new TypeError(error);
  }
  try {
    const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (decoded.byteLength !== byteLength || btoa(String.fromCharCode(...decoded)) !== value) {
      throw new TypeError(error);
    }
    return decoded;
  } catch {
    throw new TypeError(error);
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeCanonicalBase64Url(
  value: unknown,
  byteLength: number,
  error = "base64url_invalid",
): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError(error);
  try {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const decoded = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding),
      (character) => character.charCodeAt(0),
    );
    if (decoded.byteLength !== byteLength || encodeBase64Url(decoded) !== value) {
      throw new TypeError(error);
    }
    return decoded;
  } catch {
    throw new TypeError(error);
  }
}

function strictJsonCopy(value: unknown, path = "body"): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("signed_body_invalid");
    return value;
  }
  if (typeof value === "string") {
    if (!isWellFormedString(value) || value !== value.normalize("NFC")) {
      throw new TypeError("signed_body_invalid");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError("signed_body_invalid");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) {
      throw new TypeError("signed_body_invalid");
    }
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("signed_body_invalid");
      }
      result.push(strictJsonCopy(descriptor.value, `${path}[${index}]`));
    }
    return result;
  }
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError("signed_body_invalid");
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !isWellFormedString(key) || key !== key.normalize("NFC")) {
      throw new TypeError("signed_body_invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("signed_body_invalid");
    }
    Object.defineProperty(result, key, {
      value: strictJsonCopy(descriptor.value, `${path}.${key}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function isWellFormedString(value: string): boolean {
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(value);
}

type SignedBodyFrame =
  | { readonly kind: "value"; readonly value: unknown; readonly parentDepth: number }
  | { readonly kind: "leave"; readonly value: object };

/** Bounds all work performed by the recursive JSON copy and canonicalizer. */
function assertBoundedSignedBody(root: unknown): void {
  let canonicalByteCount = 0;
  let structureItems = 0;
  const activeContainers = new WeakSet<object>();
  const frames: SignedBodyFrame[] = [{ kind: "value", value: root, parentDepth: 0 }];

  const addCanonicalBytes = (count: number): void => {
    canonicalByteCount += count;
    if (canonicalByteCount > MAXIMUM_SIGNED_BODY_BYTES) throw new TypeError("signed_body_invalid");
  };
  const addCanonicalString = (value: string): void => {
    if (
      value.length > MAXIMUM_SIGNED_BODY_BYTES ||
      !isWellFormedString(value) ||
      value !== value.normalize("NFC")
    ) {
      throw new TypeError("signed_body_invalid");
    }
    addCanonicalBytes(2);
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (
        codeUnit === 0x22 ||
        codeUnit === 0x5c ||
        codeUnit === 0x08 ||
        codeUnit === 0x09 ||
        codeUnit === 0x0a ||
        codeUnit === 0x0c ||
        codeUnit === 0x0d
      ) {
        addCanonicalBytes(2);
      } else if (codeUnit <= 0x1f) {
        addCanonicalBytes(6);
      } else if (codeUnit <= 0x7f) {
        addCanonicalBytes(1);
      } else if (codeUnit <= 0x7ff) {
        addCanonicalBytes(2);
      } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        addCanonicalBytes(4);
        index += 1;
      } else {
        addCanonicalBytes(3);
      }
    }
  };

  while (frames.length > 0) {
    const frame = frames.pop() as SignedBodyFrame;
    if (frame.kind === "leave") {
      activeContainers.delete(frame.value);
      continue;
    }

    structureItems += 1;
    if (structureItems > MAXIMUM_SIGNED_BODY_STRUCTURE_ITEMS) {
      throw new TypeError("signed_body_invalid");
    }
    const value = frame.value;
    if (value === null) {
      addCanonicalBytes(4);
      continue;
    }
    if (typeof value === "boolean") {
      addCanonicalBytes(value ? 4 : 5);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("signed_body_invalid");
      addCanonicalBytes(JSON.stringify(value).length);
      continue;
    }
    if (typeof value === "string") {
      addCanonicalString(value);
      continue;
    }
    if (typeof value !== "object") throw new TypeError("signed_body_invalid");

    const containerDepth = frame.parentDepth + 1;
    if (containerDepth > MAXIMUM_SIGNED_BODY_DEPTH || activeContainers.has(value)) {
      throw new TypeError("signed_body_invalid");
    }
    activeContainers.add(value);

    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        structureItems + value.length > MAXIMUM_SIGNED_BODY_STRUCTURE_ITEMS
      ) {
        throw new TypeError("signed_body_invalid");
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length")) {
        throw new TypeError("signed_body_invalid");
      }
      addCanonicalBytes(2 + Math.max(0, value.length - 1));
      const children: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("signed_body_invalid");
        }
        children.push(descriptor.value);
      }
      frames.push({ kind: "leave", value });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        frames.push({ kind: "value", value: children[index], parentDepth: containerDepth });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("signed_body_invalid");
    }
    const keys = Reflect.ownKeys(value);
    if (structureItems + keys.length * 2 > MAXIMUM_SIGNED_BODY_STRUCTURE_ITEMS) {
      throw new TypeError("signed_body_invalid");
    }
    structureItems += keys.length;
    addCanonicalBytes(2 + Math.max(0, keys.length - 1));
    const children: unknown[] = [];
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError("signed_body_invalid");
      addCanonicalString(key);
      addCanonicalBytes(1);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("signed_body_invalid");
      }
      children.push(descriptor.value);
    }
    frames.push({ kind: "leave", value });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      frames.push({ kind: "value", value: children[index], parentDepth: containerDepth });
    }
  }
}

export function decodeCanonicalRawBody(rawBody: Uint8Array): JsonValue {
  if (!(rawBody instanceof Uint8Array)) throw new TypeError("signed_body_invalid");
  if (rawBody.byteLength > MAXIMUM_SIGNED_BODY_BYTES) throw new TypeError("signed_body_invalid");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody);
  } catch {
    throw new TypeError("signed_body_invalid");
  }
  if (text.startsWith("\uFEFF")) throw new TypeError("signed_body_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("signed_body_invalid");
  }
  assertBoundedSignedBody(parsed);
  const copied = strictJsonCopy(parsed);
  if (!byteEqual(canonicalBytes(copied), rawBody)) {
    throw new TypeError("signed_body_noncanonical");
  }
  return copied;
}

export function validateRequest(value: unknown): SignedRequestV1 {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("signed_request_invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== REQUEST_FIELDS.length ||
    keys.some((key) => typeof key !== "string" || !REQUEST_FIELD_SET.has(key))
  ) {
    throw new TypeError("signed_request_invalid");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of REQUEST_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("signed_request_invalid");
    }
    result[field] = descriptor.value;
  }
  if (
    result.schemaVersion !== "1.0" ||
    !isSafeAtom(result.deviceId, 256) ||
    !isSafeAtom(result.principalId, 256) ||
    !isSafeAtom(result.audience, 128)
  ) {
    throw new TypeError("signed_request_invalid");
  }
  if (
    parseTimestamp(result.issuedAt) === null ||
    typeof result.bodyHash !== "string" ||
    !SHA256.test(result.bodyHash)
  ) {
    throw new TypeError("signed_request_invalid");
  }
  decodeCanonicalBase64Url(result.nonce, 32, "signed_request_invalid");
  decodeCanonicalBase64(result.signatureBase64, 64, "signature_invalid");
  return result as unknown as SignedRequestV1;
}

export function signatureText(
  request: SignedRequestV1,
  method: "GET" | "POST",
  path: string,
): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(
    [
      method,
      path,
      request.deviceId,
      request.principalId,
      request.audience,
      request.issuedAt,
      request.nonce,
      request.bodyHash,
    ].join("\n"),
  );
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
