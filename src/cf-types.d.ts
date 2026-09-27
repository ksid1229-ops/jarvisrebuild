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
/** The Workers server-side WebSocket (has accept(), unlike the browser one). */
declare interface CfWebSocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", handler: (event: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: "close" | "error", handler: (event: unknown) => void): void;
}
declare const WebSocketPair: { new (): { 0: CfWebSocket; 1: CfWebSocket } };
