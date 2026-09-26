import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";

/**
 * The tool dispatcher and confirmation gate.
 *
 * Every tool call the model makes goes through dispatch(). Two guarantees code
 * enforces here, that the model cannot talk its way past:
 *  1. A confirmable tool (one of the five actions) NEVER runs on first call. It
 *     is stored as a pending action bound to (tool, exact args) and a summary is
 *     sent to Sid. It runs only via executeConfirmed(), after Sid confirms.
 *  2. Shadow mode: when on, a confirmed action logs "would have done X" and does
 *     not execute.
 *
 * Every dispatch is logged as a receipt (Proof).
 */
export class ToolDispatcher {
  private readonly registry = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const t of tools) this.registry.set(t.name, t);
  }

  register(tool: Tool): void {
    this.registry.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.registry.delete(name);
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  list(): Tool[] {
    return [...this.registry.values()];
  }

  /** Called by the agent loop for each tool call the model emits. */
  async dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (!tool) {
      const result: ToolResult = { ok: false, status: "refused", message: `unknown tool: ${name}` };
      ctx.receipts.log({ tool: name, input: args, result, trigger: ctx.trigger, performed: false, status: "refused" });
      return result;
    }

    if (tool.confirmable) {
      return this.requestConfirmation(tool, args, ctx);
    }

    // Ordinary tool: run and log.
    let result: ToolResult;
    try {
      result = await tool.run(args, ctx);
    } catch (e) {
      result = { ok: false, status: "error", message: (e as Error).message };
    }
    ctx.receipts.log({
      tool: name,
      input: args,
      result,
      trigger: ctx.trigger,
      performed: result.ok && result.status === "ok",
      status: result.status,
    });
    return result;
  }

  private async requestConfirmation(tool: Tool, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // The action args are the args minus the model's optional summary phrasing.
    const actionArgs = { ...args };
    const providedSummary = typeof actionArgs.confirmation_summary === "string" ? (actionArgs.confirmation_summary as string) : undefined;
    delete actionArgs.confirmation_summary;

    const existing = await ctx.pending.findPendingMatch(tool.name, actionArgs, ctx.ownerId);
    if (existing) {
      const result: ToolResult = {
        ok: false,
        status: "confirmation_requested",
        message: `Already waiting on Sid to confirm this. pending_id=${existing.id}`,
        data: { pending_id: existing.id },
      };
      ctx.receipts.log({ tool: tool.name, input: args, result, trigger: ctx.trigger, performed: false, status: "confirmation_requested" });
      return result;
    }

    const summary = providedSummary ?? buildSummary(tool.name, actionArgs);
    const pending = await ctx.pending.create({
      tool: tool.name,
      args: actionArgs,
      summary,
      ownerId: ctx.ownerId,
      creatingEventId: ctx.eventId,
    });

    // Send Sid the confirmation. In the real Telegram channel this carries an
    // inline YES/NO tap; the fake channel just delivers the text. A failed send
    // is surfaced, not swallowed.
    const send = await ctx.ownerChannel.sendText(
      `Just to be sure — ${summary}\nReply YES to confirm or NO to cancel. (id ${pending.id})`,
    );

    const result: ToolResult = {
      ok: false,
      status: "confirmation_requested",
      message: send.ok
        ? `Sent Sid a confirmation. It runs only after he confirms. pending_id=${pending.id}`
        : `Created pending action but the confirmation send FAILED (${send.status}). pending_id=${pending.id}`,
      data: { pending_id: pending.id, sendStatus: send.status },
    };
    ctx.receipts.log({
      tool: tool.name,
      input: args,
      result,
      trigger: ctx.trigger,
      performed: false,
      status: "confirmation_requested",
    });
    return result;
  }

  /**
   * Execute a confirmed pending action. Called by confirm_action (model path) or
   * by a structured tap/PIN (code path). Code checks the action is Sid's,
   * unexpired, still pending, and not self-confirmed within its own turn.
   */
  async executeConfirmed(pendingId: string, ctx: ToolContext): Promise<ToolResult> {
    let action;
    try {
      action = ctx.pending.confirm(pendingId, ctx.ownerId, ctx.eventId);
    } catch (e) {
      const result: ToolResult = { ok: false, status: "refused", message: (e as Error).message };
      ctx.receipts.log({ tool: "confirm_action", input: { pendingId }, result, trigger: ctx.trigger, performed: false, status: "refused" });
      return result;
    }

    const tool = this.registry.get(action.tool);
    if (!tool) {
      const result: ToolResult = { ok: false, status: "error", message: `pending action names unknown tool ${action.tool}` };
      ctx.receipts.log({ tool: action.tool, input: {}, result, trigger: ctx.trigger, performed: false, status: "error" });
      return result;
    }

    // On a call, a confirmed action ALSO requires a verified PIN at this moment.
    // Caller ID can be spoofed, so identity alone is never enough. Fail closed.
    if (ctx.provenance.channel === "voice" && !(ctx.call && ctx.call.pinVerified)) {
      const result: ToolResult = {
        ok: false,
        status: "pin_required",
        message: "This action needs Sid's 4-digit PIN on the call. Ask him to say or key it, then confirm again.",
      };
      ctx.receipts.log({ tool: action.tool, input: {}, result, trigger: ctx.trigger, performed: false, status: "pin_required" });
      return result;
    }

    const args = JSON.parse(action.argsJson) as Record<string, unknown>;

    // Shadow mode: log what would have happened, do not execute.
    if (ctx.settings.isFeatureShadow(action.tool)) {
      const result: ToolResult = {
        ok: true,
        status: "shadow",
        message: `Shadow mode: would have done — ${action.summary}. Nothing was executed.`,
        data: { wouldHave: action.summary },
      };
      ctx.pending.markExecuted(action.id);
      ctx.receipts.log({ tool: action.tool, input: args, result, trigger: ctx.trigger, performed: false, status: "shadow" });
      return result;
    }

    let result: ToolResult;
    try {
      result = await tool.run(args, ctx);
    } catch (e) {
      result = { ok: false, status: "error", message: (e as Error).message };
    }
    ctx.pending.markExecuted(action.id);
    ctx.receipts.log({
      tool: action.tool,
      input: args,
      result,
      trigger: ctx.trigger,
      performed: result.ok && result.status === "ok",
      status: result.status,
    });
    return result;
  }
}

/** A factual description of a pending action (a receipt, not a judgment). */
function buildSummary(tool: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return `${tool}(${parts})`;
}
