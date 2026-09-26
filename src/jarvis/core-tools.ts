import type { Tool, ToolContext, ToolResult } from "./tool-types.js";

/**
 * send_text: deliver a message to Sid. Used for proactive sends (wake-ups,
 * digests) where there is no reply to return. It surfaces the real delivery
 * status — a failed send is NEVER reported as success.
 */
export const sendText: Tool = {
  name: "send_text",
  description:
    "Send Sid a text message right now. Use this to reach him proactively (a wake-up fired, a " +
    "digest is ready). For a normal reply to something he just said, you can also just write your " +
    "reply as the assistant message. message: what to send.",
  parameters: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const message = String(args.message ?? "");
    if (message.trim() === "") return { ok: false, status: "refused", message: "message is empty." };
    const res = await ctx.ownerChannel.sendText(message);
    if (!res.ok) {
      return { ok: false, status: res.status, message: `send failed: ${res.detail ?? res.status}` };
    }
    return { ok: true, status: "ok", message: "sent" };
  },
};

export const receiptsQuery: Tool = {
  name: "receipts_query",
  description:
    "Look up what you actually did — the proof. Use it when Sid asks 'what did you do today?' or " +
    "you need evidence an action really happened. Optional from/to are RFC3339 UTC; optional tool " +
    "filters to one tool name.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      tool: { type: "string" },
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    const rows = ctx.receipts.query({
      fromIso: typeof args.from === "string" ? args.from : undefined,
      toIso: typeof args.to === "string" ? args.to : undefined,
      tool: typeof args.tool === "string" ? args.tool : undefined,
    });
    return {
      ok: true,
      status: "ok",
      data: rows.map((r) => ({
        at: r.at,
        tool: r.tool,
        performed: r.performed,
        status: r.status,
        input: r.inputJson,
        result: r.resultJson,
        trigger: r.trigger,
      })),
    };
  },
};

export const settingsUpdate: Tool = {
  name: "settings_update",
  description:
    "Change a setting because Sid asked. The main one is shadow mode: settings_update(key='shadow', " +
    "value='on') makes action tools log what they WOULD do instead of doing it; value='off' turns it " +
    "back on live. Per-feature shadow uses key='shadow:<feature>'.",
  parameters: {
    type: "object",
    properties: { key: { type: "string" }, value: { type: "string" } },
    required: ["key", "value"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const key = String(args.key ?? "");
    const value = String(args.value ?? "");
    if (key === "") return { ok: false, status: "refused", message: "key is required." };
    ctx.settings.set(key, value);
    return { ok: true, status: "ok", message: `set ${key}=${value}` };
  },
};

/**
 * confirm_action / cancel_action. The model calls these once it judges that Sid
 * said yes/no. Code checks ONLY that the pending action exists, is Sid's, is
 * unexpired, and (guard) was not created in this same turn. It does not read
 * Sid's words. Execution of the underlying action happens inside the gate.
 */
export function makeConfirmTools(execute: (pendingId: string, ctx: ToolContext) => Promise<ToolResult>): Tool[] {
  const confirm: Tool = {
    name: "confirm_action",
    description:
      "Confirm a pending action that is waiting on Sid's approval, once he has approved it. Pass the " +
      "pending_id from the confirmation you requested. If the action was changed, it needs a fresh " +
      "confirmation — you cannot confirm a different action with an old id.",
    parameters: { type: "object", properties: { pending_id: { type: "string" } }, required: ["pending_id"] },
    async run(args, ctx): Promise<ToolResult> {
      return execute(String(args.pending_id), ctx);
    },
  };
  const cancel: Tool = {
    name: "cancel_action",
    description: "Cancel a pending action Sid declined. Pass the pending_id.",
    parameters: { type: "object", properties: { pending_id: { type: "string" } }, required: ["pending_id"] },
    async run(args, ctx): Promise<ToolResult> {
      try {
        const a = ctx.pending.cancel(String(args.pending_id), ctx.ownerId);
        return { ok: true, status: "ok", message: `cancelled ${a.id}` };
      } catch (e) {
        return { ok: false, status: "refused", message: (e as Error).message };
      }
    },
  };
  return [confirm, cancel];
}
