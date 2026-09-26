/**
 * Canonical JSON, byte-compatible with the School Helper app and the original
 * D2L collector protocol. The school receiver hashes the exact bytes it is
 * sent, so this serializer must agree with the app's `canonical()` exactly:
 * key order, Unicode normalization and the structural bounds are all part of
 * the contract, not preferences.
 *
 * Ported from the proven reference (stremysid/jarvis apps/d2l-extension
 * protocol.js `canonical`, read at commit 0c56920). Byte-compatibility is
 * pinned by known-answer vectors in test/school-protocol.test.ts — the same
 * vectors the app's suite must also pin, so a drift on either side fails
 * loudly instead of in production.
 */

const encoder = new TextEncoder();

/** Receiver limits. Exceeding any bound is a refusal, never a truncation. */
export const MAX_BODY_BYTES = 65536;
export const MAX_STRUCTURE_ITEMS = 4096;
export const MAX_DEPTH = 32;

export class CanonicalError extends Error {}

/**
 * Deterministic JSON: keys NFC-normalized and sorted, strings NFC-normalized,
 * no insignificant whitespace.
 */
export function canonical(value: unknown): string {
  let items = 0;

  const str = (text: string): string => {
    if (!isWellFormed(text)) throw new CanonicalError("invalid-unicode");
    return JSON.stringify(text.normalize("NFC"));
  };

  const visit = (node: unknown, depth: number): string => {
    items += 1;
    if (items > MAX_STRUCTURE_ITEMS) throw new CanonicalError("batch-structure-too-large");
    if (node === null || typeof node === "boolean") return JSON.stringify(node);
    if (typeof node === "string") return str(node);
    if (typeof node === "number" && Number.isFinite(node)) return JSON.stringify(node);
    if (typeof node !== "object" || depth >= MAX_DEPTH)
      throw new CanonicalError("invalid-batch-structure");
    if (Array.isArray(node)) return `[${node.map((e) => visit(e, depth + 1)).join(",")}]`;

    const record = node as Record<string, unknown>;
    const keys = Object.keys(record)
      .map((key) => [key.normalize("NFC"), key] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (new Set(keys.map(([k]) => k)).size !== keys.length) {
      throw new CanonicalError("duplicate-normalized-key");
    }
    items += keys.length;
    return `{${keys.map(([k, orig]) => `${str(k)}:${visit(record[orig], depth + 1)}`).join(",")}}`;
  };

  const text = visit(value, 0);
  if (encoder.encode(text).length >= MAX_BODY_BYTES) throw new CanonicalError("batch-too-large");
  return text;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonical(value));
}

function isWellFormed(text: string): boolean {
  // String.prototype.isWellFormed is ES2024; Workers has it, test envs may not.
  const maybe = text as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(text);
}
