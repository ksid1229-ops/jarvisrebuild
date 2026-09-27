import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";

const noManager = (): ToolResult => ({
  ok: false,
  status: "not_connected",
  message: "Connected-apps support is not wired in this context.",
});

/** Shared validation for connect_app's run() and preview(). */
function connectInput(args: Record<string, unknown>): { name: string; baseUrl: string; authSecret: string } {
  const name = String(args.name ?? "");
  const baseUrl = String(args.base_url ?? "");
  const authSecret = String(args.auth_secret ?? "");
  if (name === "" || baseUrl === "" || authSecret === "") {
    throw new Error("name, base_url and auth_secret are all required.");
  }
  return { name, baseUrl, authSecret };
}

/**
 * connect_app — Sid connects an app by telling Jarvis. This is a one-time setup
 * step, so it is confirmable: it routes through the same enforced confirmation as
 * the five actions. After Sid confirms, the app's tools load into the catalogue.
 */
export const connectApp: Tool = {
  name: "connect_app",
  description:
    "Connect an external app so its tools become yours (on text and voice). Use when Sid asks to " +
    "connect an app. This needs Sid's confirmation because it grants the app a place in your tools. " +
    "name: a short label for the app. base_url: its HTTPS base. auth_secret: the shared secret Sid gives you.",
  confirmable: true,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      base_url: { type: "string" },
      auth_secret: { type: "string" },
      confirmation_summary: { type: "string" },
    },
    required: ["name", "base_url", "auth_secret"],
  },
  /**
   * Pre-check (audit round 3): the confirmation Sid sees lists the app's tools
   * and which of them run without asking — the app declares its own confirmable
   * flags, so the least Jarvis owes Sid is to put them in writing before he
   * says yes. If the app's /tools endpoint is down, the connect is refused
   * here (it would fail at execution anyway).
   */
  async preview(args, ctx): Promise<string> {
    if (!ctx.apps) return "";
    const input = connectInput(args);
    const specs = await ctx.apps.peekTools(input);
    const lines =
      specs.length === 0
        ? "  (no tools)"
        : specs.map((s) => `  - ${s.name} (${s.confirmable === true ? "asks you first" : "runs freely"})`).join("\n");
    return (
      `What you are trusting: this adds ${specs.length} tool(s) to Jarvis's catalogue, and the model ` +
      `may call them whenever it decides (every call is receipted):\n${lines}\n` +
      `The app can also POST events that wake Jarvis.`
    );
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.apps) return noManager();
    let input: { name: string; baseUrl: string; authSecret: string };
    try {
      input = connectInput(args);
    } catch (e) {
      return { ok: false, status: "refused", message: (e as Error).message };
    }
    try {
      const { app, toolNames } = await ctx.apps.connect(input);
      return {
        ok: true,
        status: "ok",
        message: `Connected '${app.name}' (${app.id}); loaded ${toolNames.length} tool(s): ${toolNames.join(", ")}`,
        data: { appId: app.id, toolNames },
      };
    } catch (e) {
      // Failure is visible.
      return { ok: false, status: "app_error", message: `Could not connect app: ${(e as Error).message}` };
    }
  },
};

export const disconnectApp: Tool = {
  name: "disconnect_app",
  description: "Remove a connected app and unload its tools. app_id from list_connected_apps.",
  parameters: { type: "object", properties: { app_id: { type: "string" } }, required: ["app_id"] },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.apps) return noManager();
    const ok = await ctx.apps.disconnect(String(args.app_id));
    return ok
      ? { ok: true, status: "ok", message: `Disconnected ${args.app_id}` }
      : { ok: false, status: "refused", message: `No such app ${args.app_id}` };
  },
};

export const listConnectedApps: Tool = {
  name: "list_connected_apps",
  description: "List the apps currently connected, with their ids and when they were added.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx): Promise<ToolResult> {
    if (!ctx.apps) return noManager();
    const list = await ctx.apps.list();
    return {
      ok: true,
      status: "ok",
      data: list.map((a) => ({ id: a.id, name: a.name, baseUrl: a.baseUrl, enabled: a.enabled, addedAt: a.addedAt })),
    };
  },
};

export const appContext: Tool = {
  name: "app_context",
  description:
    "Ask a connected app for its 'what you should know right now' read — e.g. before a morning digest. " +
    "app_id: which app. You decide what, if anything, from the result matters.",
  parameters: { type: "object", properties: { app_id: { type: "string" } }, required: ["app_id"] },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.apps) return noManager();
    const connector = ctx.apps.connectorFor(String(args.app_id));
    if (!connector) return { ok: false, status: "refused", message: `No such app ${args.app_id}` };
    if (!connector.getContext) return { ok: false, status: "unsupported", message: "That app exposes no context read." };
    const res = await connector.getContext();
    return { ok: res.ok, status: res.status, message: res.message, data: res.data };
  },
};

export const appTools: Tool[] = [connectApp, disconnectApp, listConnectedApps, appContext];
