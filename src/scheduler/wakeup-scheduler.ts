import type { Clock } from "../clock.js";
import type { Wakeup, WakeupKind } from "../types.js";
import type { WakeupsStore } from "./wakeups-repo.js";

/** Points the Durable Object's single alarm (storage.setAlarm / deleteAlarm). */
/** How long a failed wake-up waits before the alarm retries it. */
export const RETRY_FLOOR_MS = 5 * 60 * 1000;

export type SetAlarm = (fireAtIso: string | null) => void | Promise<void>;

/**
 * Manages wake-ups against a single Durable Object alarm. Every change re-points
 * the alarm at the EARLIEST pending wake-up (or clears it if none). Firing is
 * driven by fireDue(): the DO alarm handler (or the hourly cron) calls it, and
 * every wake-up whose time has passed is delivered to Jarvis, then removed.
 */
export class WakeupScheduler {
  constructor(
    private readonly repo: WakeupsStore,
    private readonly clock: Clock,
    private readonly setAlarm: SetAlarm = () => {},
  ) {}

  async schedule(fireAtIso: string, reason: string): Promise<Wakeup> {
    if (Number.isNaN(Date.parse(fireAtIso))) {
      throw new Error(`fire_at is not a real instant: ${fireAtIso}`);
    }
    const w = await this.repo.add(fireAtIso, reason);
    await this.resetAlarm();
    return w;
  }

  /**
   * (Re)arm a system timer: replaces any pending timer of the same kind, so a
   * conversation that keeps going keeps pushing the quiet-review later.
   */
  async setSystemTimer(kind: Exclude<WakeupKind, "owner">, fireAtIso: string, reason: string): Promise<Wakeup> {
    if (Number.isNaN(Date.parse(fireAtIso))) throw new Error(`fire_at is not a real instant: ${fireAtIso}`);
    await this.repo.removeKind(kind);
    const w = await this.repo.add(fireAtIso, reason, kind);
    await this.resetAlarm();
    return w;
  }

  async list(): Promise<Wakeup[]> {
    return this.repo.list();
  }

  async cancel(id: string): Promise<boolean> {
    const ok = await this.repo.remove(id);
    if (ok) await this.resetAlarm();
    return ok;
  }

  async earliest(): Promise<Wakeup | null> {
    return (await this.repo.list())[0] ?? null;
  }

  /** Wake-ups whose time is at or before now. */
  async due(): Promise<Wakeup[]> {
    const now = this.clock.nowMs();
    return (await this.repo.list()).filter((w) => new Date(w.fireAt).getTime() <= now);
  }

  /**
   * Fire every due wake-up via onFire, remove it, then re-point the alarm.
   * A wake-up whose handler throws is NOT removed (it fires again on the next
   * alarm/cron) and the error is collected and returned — never dropped. One
   * failing wake-up does not block the others.
   */
  async fireDue(onFire: (w: Wakeup) => Promise<void>): Promise<{ fired: number; failed: { id: string; error: string }[] }> {
    const due = await this.due();
    let fired = 0;
    const failed: { id: string; error: string }[] = [];
    for (const w of due) {
      try {
        await onFire(w);
      } catch (e) {
        failed.push({ id: w.id, error: (e as Error).message });
        continue;
      }
      await this.repo.remove(w.id);
      fired += 1;
    }
    // A failed wake-up is still due; without a floor the alarm would re-fire
    // instantly in a hot loop while (say) the model is down.
    await this.resetAlarm(failed.length > 0 ? this.clock.nowMs() + RETRY_FLOOR_MS : undefined);
    return { fired, failed };
  }

  /** Re-point the alarm at the earliest pending wake-up (also used on DO start). */
  async resetAlarm(notBeforeMs?: number): Promise<void> {
    const next = await this.earliest();
    if (!next) return this.setAlarm(null);
    const at = notBeforeMs !== undefined ? Math.max(Date.parse(next.fireAt), notBeforeMs) : Date.parse(next.fireAt);
    await this.setAlarm(new Date(at).toISOString());
  }
}
