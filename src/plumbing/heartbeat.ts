import type { Clock } from "../clock.js";

/**
 * Every cron run records its component as alive, so a broken Jarvis can be told
 * apart from a quiet one. This is pure evidence — no judgment.
 */
export class HeartbeatRepo {
  private readonly beats = new Map<string, string>();
  constructor(private readonly clock: Clock) {}
  record(component: string): void {
    this.beats.set(component, this.clock.nowIso());
  }
  last(component: string): string | undefined {
    return this.beats.get(component);
  }
  all(): Record<string, string> {
    return Object.fromEntries(this.beats);
  }
}
