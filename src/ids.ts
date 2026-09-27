/** Id generation and canonical argument hashing. */

/**
 * Collision-safe id: a UUID under a prefix. Audit round 2: this used to be
 * Date.now + a per-isolate counter + Math.random, which is unique within one
 * isolate but only PROBABLY unique across isolates, evictions and retries —
 * and it is the primary key of every table. crypto.randomUUID is available in
 * Workers and Node 18+.
 */
export function newId(prefix = "id"): string {
  return `${prefix}_${crypto.randomUUID()}`;
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
