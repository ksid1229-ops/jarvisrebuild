/**
 * Canonical JSON, byte-compatible with the Jarvis receiver.
 *
 * Ported from apps/d2l-extension/protocol.js in stremysid/jarvis (read at
 * commit 0c56920). The receiver hashes the body it is sent, so our serializer
 * has to agree with theirs exactly — key order, Unicode normalization and the
 * structural bounds all form part of the contract, not our preferences.
 */

const encoder = new TextEncoder();

/** Receiver limits. Exceeding any of these is a refusal, never a truncation. */
export const MAX_BODY_BYTES = 65536;
export const MAX_STRUCTURE_ITEMS = 4096;
export const MAX_DEPTH = 32;

export class CanonicalError extends Error {}

function isWellFormed(text: string): boolean {
  // String.prototype.isWellFormed is ES2024; MV3 Chrome has it, jsdom may not.
  const anyStr = text as unknown as { isWellFormed?: () => boolean };
  if (typeof anyStr.isWellFormed === 'function') return anyStr.isWellFormed();
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(text);
}

/**
 * Deterministic JSON: keys NFC-normalized and sorted, strings NFC-normalized,
 * no insignificant whitespace.
 */
export function canonical(value: unknown): string {
  let items = 0;

  const str = (text: string): string => {
    if (!isWellFormed(text)) throw new CanonicalError('invalid-unicode');
    return JSON.stringify(text.normalize('NFC'));
  };

  const visit = (node: unknown, depth: number): string => {
    items += 1;
    if (items > MAX_STRUCTURE_ITEMS) throw new CanonicalError('batch-structure-too-large');
    if (node === null || typeof node === 'boolean') return JSON.stringify(node);
    if (typeof node === 'string') return str(node);
    if (typeof node === 'number' && Number.isFinite(node)) return JSON.stringify(node);
    if (typeof node !== 'object' || depth >= MAX_DEPTH)
      throw new CanonicalError('invalid-batch-structure');
    if (Array.isArray(node)) return `[${node.map((e) => visit(e, depth + 1)).join(',')}]`;

    const record = node as Record<string, unknown>;
    const keys = Object.keys(record)
      .map((key) => [key.normalize('NFC'), key] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (new Set(keys.map(([k]) => k)).size !== keys.length) {
      throw new CanonicalError('duplicate-normalized-key');
    }
    items += keys.length;
    return `{${keys.map(([k, orig]) => `${str(k)}:${visit(record[orig], depth + 1)}`).join(',')}}`;
  };

  const text = visit(value, 0);
  if (encoder.encode(text).length >= MAX_BODY_BYTES) throw new CanonicalError('batch-too-large');
  return text;
}

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** True when the value serializes within every receiver bound. */
export function fitsOnTheWire(value: unknown): boolean {
  try {
    canonical(value);
    return true;
  } catch {
    return false;
  }
}
