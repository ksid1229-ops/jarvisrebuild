import type { Clock } from "../clock.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { str } from "../persistence/d1.js";

/**
 * Every cron run records its component as alive, so a broken Jarvis can be told
 * apart from a quiet one. This is pure evidence — no judgment.
 */
export interface HeartbeatStore {
  record(component: string): Promise<void>;
  last(component: string): Promise<string | undefined>;
  all(): Promise<Record<string, string>>;
}

export class HeartbeatRepo implements HeartbeatStore {
  private readonly beats = new Map<string, string>();
  constructor(private readonly clock: Clock) {}
  async record(component: string): Promise<void> {
    this.beats.set(component, this.clock.nowIso());
  }
  async last(component: string): Promise<string | undefined> {
    return this.beats.get(component);
  }
  async all(): Promise<Record<string, string>> {
    return Object.fromEntries(this.beats);
  }
}

/** D1-backed heartbeats. Same interface, real persistence. */
export class D1HeartbeatRepo implements HeartbeatStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
  ) {}

  async record(component: string): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO heartbeats (component, last_beat) VALUES (?, ?)`)
      .bind(component, this.clock.nowIso())
      .run();
  }

  async last(component: string): Promise<string | undefined> {
    const row = await this.db.prepare(`SELECT last_beat FROM heartbeats WHERE component = ?`).bind(component).first<D1Row>();
    return row ? str(row.last_beat, "heartbeats.last_beat") : undefined;
  }

  async all(): Promise<Record<string, string>> {
    const res = await this.db.prepare(`SELECT component, last_beat FROM heartbeats`).all<D1Row>();
    const out: Record<string, string> = {};
    for (const row of res.results) {
      out[str(row.component, "heartbeats.component")] = str(row.last_beat, "heartbeats.last_beat");
    }
    return out;
  }
}
