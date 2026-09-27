import type { AgentCore, AgentResult, JarvisEvent } from "../jarvis/agent-core.js";
import type { WakeupScheduler } from "./wakeup-scheduler.js";
import type { HeartbeatStore } from "../plumbing/heartbeat.js";
import type { WatchdogPinger } from "../plumbing/watchdog.js";
import type { BackupService } from "../plumbing/backup.js";
import { newId } from "../ids.js";
import type { Wakeup } from "../types.js";
import type { MemoryReviewer, MemoryRun } from "../memory/memory-review.js";

/** Build a wake-up event for Jarvis. The model decides what to DO with it. */
export function wakeupEvent(reason: string): JarvisEvent {
  // No Date.now(): the event id is already unique; the clock stays injected.
  const eventId = newId("evt");
  return {
    channel: "text",
    trigger: "wakeup",
    eventId,
    text: reason,
    provenance: {
      channel: "text",
      isOwner: true,
      isForwarded: false,
      isPrivate: true,
      sourceRef: `wakeup:${eventId}`,
      sourceType: "conversation",
    },
  };
}

export const HOURLY_CRON = "0 * * * *";
export const NIGHTLY_CRON = "30 5 * * *"; // 05:30 UTC (~1:30 AM Eastern in summer)

export interface WakeupDeps {
  agent: Pick<AgentCore, "handle">;
  reviewer?: MemoryReviewer;
}

/**
 * Deliver ONE due wake-up. Used by the Durable Object alarm and the hourly cron.
 *  - memory_review (the conversation-went-quiet timer) runs a memory review. Its
 *    failures are recorded in memory_runs and retried by the hourly review, so
 *    it does not throw (a throw would keep re-arming the alarm).
 *  - owner reminders go to Jarvis as a wake-up; a model error THROWS so the
 *    scheduler keeps the wake-up and retries it, instead of dropping it.
 */
export async function fireWakeup(w: Wakeup, deps: WakeupDeps): Promise<void> {
  if (w.kind === "memory_review") {
    if (!deps.reviewer) throw new Error("memory review timer fired but no reviewer is wired");
    await deps.reviewer.run("quiet_alarm");
    return;
  }
  const result: AgentResult = await deps.agent.handle(wakeupEvent(w.reason));
  if (result.error) throw new Error(`wake-up ${w.id} not delivered: ${result.error}`);
}

export interface CronDeps extends WakeupDeps {
  cronExpr: string;
  agent: AgentCore;
  scheduler: WakeupScheduler;
  heartbeat: HeartbeatStore;
  watchdog: WatchdogPinger;
  backup: BackupService;
  /** Hourly re-index of facts missing from the meaning index. */
  reindex?: () => Promise<{ indexed: number; failed: { id: string; error: string }[]; remaining: number }>;
}

export interface CronResult {
  ran: string[];
  wakeupsFired: number;
  wakeupsFailed: { id: string; error: string }[];
  hourlyCheck?: { ok: boolean; error?: string };
  memoryReview?: Pick<MemoryRun, "id" | "status" | "messagesReviewed" | "messagesDeferred" | "factsSaved" | "factsCorrected" | "error">;
  reindex?: { indexed: number; failed: number; remaining: number };
  watchdog?: { ok: boolean; status: string };
  backupKey?: string;
  backupCounts?: Record<string, number>;
}

/**
 * The cron entry point. It is deliberately dumb: it fires due wake-ups, hands
 * Jarvis an "hourly check", pings the watchdog, records a heartbeat, and runs the
 * nightly backup. WHETHER something found is worth interrupting Sid for, whether
 * to send a morning digest and when, the Sunday retro — all of that is the
 * MODEL's decision, reached by handling the wake-up. Code decides nothing here.
 */
export async function handleCron(deps: CronDeps): Promise<CronResult> {
  const ran: string[] = [];
  await deps.heartbeat.record(`cron:${deps.cronExpr}`);
  const result: CronResult = { ran, wakeupsFired: 0, wakeupsFailed: [] };

  if (deps.cronExpr === HOURLY_CRON) {
    ran.push("fire_due_wakeups");
    const fired = await deps.scheduler.fireDue((w) => fireWakeup(w, deps));
    result.wakeupsFired = fired.fired;
    result.wakeupsFailed = fired.failed;

    ran.push("hourly_check");
    const check = await deps.agent.handle(
      wakeupEvent("hourly check: review new events and anything scheduled; decide what, if anything, to tell Sid"),
    );
    result.hourlyCheck = check.error ? { ok: false, error: check.error } : { ok: true };

    if (deps.reviewer) {
      ran.push("memory_review");
      const run = await deps.reviewer.run("hourly_cron");
      result.memoryReview = {
        id: run.id,
        status: run.status,
        messagesReviewed: run.messagesReviewed,
        messagesDeferred: run.messagesDeferred,
        factsSaved: run.factsSaved,
        factsCorrected: run.factsCorrected,
        error: run.error,
      };
    }

    if (deps.reindex) {
      ran.push("memory_reindex");
      const r = await deps.reindex();
      result.reindex = { indexed: r.indexed, failed: r.failed.length, remaining: r.remaining };
    }

    ran.push("watchdog_ping");
    result.watchdog = await deps.watchdog.ping();
  }

  if (deps.cronExpr === NIGHTLY_CRON) {
    ran.push("nightly_backup");
    const b = await deps.backup.exportAll();
    result.backupKey = b.key;
    result.backupCounts = b.counts;
  }

  return result;
}
