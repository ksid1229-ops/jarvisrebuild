import type { Clock } from "../clock.js";
import type { Wakeup } from "../types.js";
import { WakeupsRepo } from "./wakeups-repo.js";

export type SetAlarm = (fireAtIso: string | null) => void;

/**
 * Manages wake-ups against a single Durable Object alarm. Every change re-points
 * the alarm at the EARLIEST pending wake-up (or clears it if none). Firing is
 * driven by fireDue(): the DO alarm handler (or the hourly cron) calls it, and
 * every wake-up whose time has passed is delivered to Jarvis, then removed.
 */
export class WakeupScheduler {
  constructor(
    private readonly repo: WakeupsRepo,
    private readonly clock: Clock,
    private readonly setAlarm: SetAlarm = () => {},
  ) {}

  schedule(fireAtIso: string, reason: string): Wakeup {
    if (Number.isNaN(Date.parse(fireAtIso))) {
      throw new Error(`fire_at is not a real instant: ${fireAtIso}`);
    }
    const w = this.repo.add(fireAtIso, reason);
    this.resetAlarm();
    return w;
  }

  list(): Wakeup[] {
    return this.repo.list();
  }

  cancel(id: string): boolean {
    const ok = this.repo.remove(id);
    if (ok) this.resetAlarm();
    return ok;
  }

  earliest(): Wakeup | null {
    return this.repo.list()[0] ?? null;
  }

  /** Wake-ups whose time is at or before now. */
  due(): Wakeup[] {
    const now = this.clock.nowMs();
    return this.repo.list().filter((w) => new Date(w.fireAt).getTime() <= now);
  }

  /**
   * Fire every due wake-up via onFire, remove it, then re-point the alarm. Returns
   * how many fired. onFire errors do not drop the wake-up silently — they surface.
   */
  async fireDue(onFire: (w: Wakeup) => Promise<void>): Promise<number> {
    const due = this.due();
    for (const w of due) {
      await onFire(w);
      this.repo.remove(w.id);
    }
    this.resetAlarm();
    return due.length;
  }

  private resetAlarm(): void {
    const next = this.earliest();
    this.setAlarm(next ? next.fireAt : null);
  }
}
