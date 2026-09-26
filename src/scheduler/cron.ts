import type { AgentCore, AgentResult, JarvisEvent } from "../jarvis/agent-core.js";
import type { WakeupScheduler } from "./wakeup-scheduler.js";
import type { HeartbeatRepo } from "../plumbing/heartbeat.js";
import type { WatchdogPinger } from "../plumbing/watchdog.js";
import type { BackupService } from "../plumbing/backup.js";
import { newId } from "../ids.js";

/** Build a wake-up event for Jarvis. The model decides what to DO with it. */
export function wakeupEvent(reason: string): JarvisEvent {
  return {
    channel: "text",
    trigger: "wakeup",
    eventId: newId("evt"),
    text: reason,
    provenance: {
      channel: "text",
      isOwner: true,
      isForwarded: false,
      isPrivate: true,
      sourceRef: `wakeup:${Date.now()}`,
      sourceType: "conversation",
    },
  };
}

export const HOURLY_CRON = "0 * * * *";
export const NIGHTLY_CRON = "30 5 * * *"; // 05:30 UTC (~1:30 AM Eastern in summer)

export interface CronDeps {
  cronExpr: string;
  agent: AgentCore;
  scheduler: WakeupScheduler;
  heartbeat: HeartbeatRepo;
  watchdog: WatchdogPinger;
  backup: BackupService;
}

export interface CronResult {
  ran: string[];
  wakeupsFired: number;
  watchdog?: { ok: boolean; status: string };
  backupKey?: string;
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
  deps.heartbeat.record(`cron:${deps.cronExpr}`);
  const result: CronResult = { ran, wakeupsFired: 0 };

  if (deps.cronExpr === HOURLY_CRON) {
    ran.push("fire_due_wakeups");
    result.wakeupsFired = await deps.scheduler.fireDue(async (w) => {
      await deps.agent.handle(wakeupEvent(w.reason));
    });
    ran.push("hourly_check");
    await deps.agent.handle(wakeupEvent("hourly check: review new events and anything scheduled; decide what, if anything, to tell Sid"));
    ran.push("watchdog_ping");
    result.watchdog = await deps.watchdog.ping();
  }

  if (deps.cronExpr === NIGHTLY_CRON) {
    ran.push("nightly_backup");
    const b = await deps.backup.exportAll();
    result.backupKey = b.key;
  }

  return result;
}
