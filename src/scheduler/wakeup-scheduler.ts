import type { Clock } from "../clock.js";
import type { Wakeup } from "../types.js";
import type { WakeupsStore } from "./wakeups-repo.js";

export type SetAlarm = (fireAtIso: string | null) => void;

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
   * Fire every due wake-up via onFire, remove it, then re-point the alarm. Returns
   * how many fired. onFire errors do not drop the wake-up silently — they surface.
   */
  async fireDue(onFire: (w: Wakeup) => Promise<void>): Promise<number> {
    const due = await this.due();
    for (const w of due) {
      await onFire(w);
      await this.repo.remove(w.id);
    }
    await this.resetAlarm();
    return due.length;
  }

  private async resetAlarm(): Promise<void> {
    const next = await this.earliest();
    this.setAlarm(next ? next.fireAt : null);
  }
}
