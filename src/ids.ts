/** Id generation and canonical argument hashing. */

let seq = 0;

/** Monotonic, sortable-ish id. Not cryptographic; only needs to be unique. */
export function newId(prefix = "id"): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}_${rand}`;
}

/** Canonical JSON: object keys sorted recursively, so equal args hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex of the canonical form. Binds a confirmation to exact arguments. */
export async function hashArgs(args: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(args));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
