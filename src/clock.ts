/**
 * Injected clock. Trap #4 from the brief: never call Date.now() directly, so
 * tests don't depend on wall-clock time. Every module that needs the time takes
 * a Clock. Timestamps are RFC 3339 UTC with milliseconds.
 */
export interface Clock {
  /** Current instant as an RFC 3339 UTC string with milliseconds, e.g. 2026-09-26T14:00:00.000Z */
  nowIso(): string;
  /** Current instant in epoch milliseconds. */
  nowMs(): number;
}

export class SystemClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
  nowMs(): number {
    return Date.now();
  }
}

/** Test clock. Advanceable, deterministic. */
export class FixedClock implements Clock {
  private ms: number;
  constructor(startIso = "2026-09-26T12:00:00.000Z") {
    this.ms = new Date(startIso).getTime();
  }
  nowIso(): string {
    return new Date(this.ms).toISOString();
  }
  nowMs(): number {
    return this.ms;
  }
  /** Advance the clock by a number of milliseconds. */
  advance(ms: number): void {
    this.ms += ms;
  }
  set(iso: string): void {
    this.ms = new Date(iso).getTime();
  }
}
