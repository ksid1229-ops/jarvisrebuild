import type { ToolSchema } from "../model/types.js";

/**
 * The connector contract (Phase 3). A connected app gives Jarvis:
 *  - HANDS: a list of tools it publishes (name, description, JSON schema). Jarvis
 *    loads them into the SAME tool catalogue as its own, on every channel.
 *  - CONTEXT: an optional "what you should know right now" read Jarvis may call.
 *  - (SENSES are events the app POSTs to Jarvis; see app-events.ts.)
 *
 * We use a plain HTTPS "list tools / call tool" contract (MCP-shaped). The app
 * writes its own tool descriptions; Jarvis decides when to call them. Permissions
 * stay in Jarvis: an app tool that performs one of the five confirmed actions
 * declares confirmable:true, and Jarvis routes it through the same enforced gate.
 */
export interface AppToolSpec {
  name: string;
  description: string;
  parameters: ToolSchema;
  /** The app declares this true if the tool performs one of Sid's five confirmed actions. */
  confirmable?: boolean;
}

export interface AppCallResult {
  ok: boolean;
  status: string;
  message?: string;
  data?: unknown;
}

export interface AppConnector {
  listTools(): Promise<AppToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<AppCallResult>;
  /** Optional "what you should know right now" read. */
  getContext?(): Promise<AppCallResult>;
}

/**
 * HTTPS connector. Endpoints on the app's base URL:
 *   GET  {base}/tools           -> { tools: AppToolSpec[] }
 *   POST {base}/call            -> { name, arguments } => AppCallResult
 *   GET  {base}/context         -> AppCallResult (optional)
 * Authenticated with the per-app secret as a bearer token.
 *
 * Failure is VISIBLE: a down app or a non-200 becomes ok:false with a real
 * status, never a silent success.
 */
export class HttpAppConnector implements AppConnector {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly baseUrl: string,
    private readonly authSecret: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.authSecret}` };
  }

  async listTools(): Promise<AppToolSpec[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/tools`, { headers: this.headers() });
    if (!res.ok) throw new Error(`app /tools returned ${res.status}`);
    const json = (await res.json()) as { tools?: AppToolSpec[] };
    return json.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<AppCallResult> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/call`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ name, arguments: args }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, status: `app_${res.status}`, message: body.slice(0, 300) };
      }
      return (await res.json()) as AppCallResult;
    } catch (e) {
      return { ok: false, status: "app_unreachable", message: (e as Error).message };
    }
  }

  async getContext(): Promise<AppCallResult> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/context`, { headers: this.headers() });
      if (!res.ok) return { ok: false, status: `app_${res.status}` };
      return (await res.json()) as AppCallResult;
    } catch (e) {
      return { ok: false, status: "app_unreachable", message: (e as Error).message };
    }
  }
}
