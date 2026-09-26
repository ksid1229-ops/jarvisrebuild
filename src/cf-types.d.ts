// Minimal ambient Cloudflare Workers types so `tsc --noEmit` passes without
// pulling the full @cloudflare/workers-types. Production uses the real types via
// wrangler; these are structural stand-ins for the handful we reference.
declare interface DurableObjectState {
  readonly storage: unknown;
  waitUntil?(p: Promise<unknown>): void;
}
declare interface DurableObjectStub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
declare interface DurableObjectId {
  toString(): string;
}
declare interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
declare interface D1Database {
  prepare(query: string): unknown;
}
declare interface R2Bucket {
  put(key: string, value: unknown): Promise<unknown>;
}
declare interface Vectorize {
  query(vector: number[], opts?: unknown): Promise<unknown>;
}
declare interface Ai {
  run(model: string, input: unknown): Promise<unknown>;
}
