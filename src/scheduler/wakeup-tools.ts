import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";

/**
 * The model sets its own reminders/wake-ups. It supplies the exact instant
 * (fire_at) — knowing Sid's timezone from the prompt — and the reason in its own
 * words. Code validates the instant is real; it never decides the schedule, the
 * lead time, or how many hours before to warn.
 */
export const scheduleWakeup: Tool = {
  name: "schedule_wakeup",
  description:
    "Schedule a wake-up: at fire_at you'll be woken with reason as an instruction, and you decide then " +
    "what to do (text Sid, call him, or nothing). Use it for reminders and your own follow-ups (e.g. " +
    "'remind him the night before the essay is due'). fire_at: an RFC3339 instant WITH offset or Z " +
    "(you know Sid's timezone from the prompt). reason: what the wake-up is for, in your words.",
  parameters: {
    type: "object",
    properties: { fire_at: { type: "string" }, reason: { type: "string" } },
    required: ["fire_at", "reason"],
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.wakeups) return { ok: false, status: "not_connected", message: "Scheduler not wired." };
    const fireAt = String(args.fire_at ?? "");
    const reason = String(args.reason ?? "");
    if (reason.trim() === "") return { ok: false, status: "refused", message: "reason is required." };
    try {
      const w = await ctx.wakeups.schedule(fireAt, reason);
      return { ok: true, status: "ok", message: `Scheduled ${w.id} for ${w.fireAt}`, data: { id: w.id, fireAt: w.fireAt } };
    } catch (e) {
      return { ok: false, status: "refused", message: (e as Error).message };
    }
  },
};

export const listWakeups: Tool = {
  name: "list_wakeups",
  description: "List your pending wake-ups with their times and reasons.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx): Promise<ToolResult> {
    if (!ctx.wakeups) return { ok: false, status: "not_connected", message: "Scheduler not wired." };
    const list = await ctx.wakeups.list();
    return { ok: true, status: "ok", data: list.map((w) => ({ id: w.id, fireAt: w.fireAt, reason: w.reason })) };
  },
};

export const cancelWakeup: Tool = {
  name: "cancel_wakeup",
  description: "Cancel a pending wake-up by id.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.wakeups) return { ok: false, status: "not_connected", message: "Scheduler not wired." };
    const ok = await ctx.wakeups.cancel(String(args.id));
    return ok
      ? { ok: true, status: "ok", message: `Cancelled ${args.id}` }
      : { ok: false, status: "refused", message: `No such wake-up ${args.id}` };
  },
};

export const wakeupTools: Tool[] = [scheduleWakeup, listWakeups, cancelWakeup];
