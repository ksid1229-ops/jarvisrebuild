import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { Wakeup } from "../types.js";

/** Stores wake-ups. A Durable Object holds ONE alarm, so the scheduler keeps the
 * list here and always points the alarm at the earliest (see WakeupScheduler). */
export class WakeupsRepo {
  private readonly wakeups = new Map<string, Wakeup>();
  constructor(private readonly clock: Clock) {}

  add(fireAtIso: string, reason: string): Wakeup {
    const w: Wakeup = {
      id: newId("wake"),
      fireAt: new Date(fireAtIso).toISOString(),
      reason,
      createdAt: this.clock.nowIso(),
    };
    this.wakeups.set(w.id, w);
    return w;
  }
  get(id: string): Wakeup | undefined {
    return this.wakeups.get(id);
  }
  remove(id: string): boolean {
    return this.wakeups.delete(id);
  }
  /** Oldest fire time first. */
  list(): Wakeup[] {
    return [...this.wakeups.values()].sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  }
}
