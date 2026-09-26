import type { AppCallResult, AppConnector, AppToolSpec } from "./connector.js";

/**
 * A small in-process fake app for tests and local runs. It plays the role of a
 * separate connected app (like the future school app) without any network: it
 * publishes tools, answers calls, exposes a context read, and records what it
 * was called with. One of its tools is declared confirmable, to prove that an
 * app's confirmed action routes through Jarvis's gate.
 */
export class FakeApp implements AppConnector {
  public readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  public reachable = true;

  constructor(private readonly name = "testapp") {}

  async listTools(): Promise<AppToolSpec[]> {
    if (!this.reachable) throw new Error("app unreachable");
    return [
      {
        name: "get_status",
        description: "Return the current status from the test app.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "submit_thing",
        description: "Submit a thing (an action that needs Sid's confirmation).",
        parameters: { type: "object", properties: { thing: { type: "string" } }, required: ["thing"] },
        confirmable: true,
      },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<AppCallResult> {
    this.calls.push({ name, args });
    if (!this.reachable) return { ok: false, status: "app_unreachable", message: "down" };
    if (name === "get_status") return { ok: true, status: "ok", data: { status: "green" } };
    if (name === "submit_thing") return { ok: true, status: "ok", data: { submitted: args.thing } };
    return { ok: false, status: "unknown_tool", message: name };
  }

  async getContext(): Promise<AppCallResult> {
    if (!this.reachable) return { ok: false, status: "app_unreachable" };
    return { ok: true, status: "ok", data: { note: "one item needs attention" } };
  }
}
