import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { str } from "../persistence/d1.js";
import type { Wakeup } from "../types.js";

/** Stores wake-ups. A Durable Object holds ONE alarm, so the scheduler keeps the
 * list here and always points the alarm at the earliest (see WakeupScheduler). */
export interface WakeupsStore {
  add(fireAtIso: string, reason: string): Promise<Wakeup>;
  get(id: string): Promise<Wakeup | undefined>;
  remove(id: string): Promise<boolean>;
  /** Oldest fire time first. */
  list(): Promise<Wakeup[]>;
}

export class WakeupsRepo implements WakeupsStore {
  private readonly wakeups = new Map<string, Wakeup>();
  constructor(private readonly clock: Clock) {}

  async add(fireAtIso: string, reason: string): Promise<Wakeup> {
    const w: Wakeup = {
      id: newId("wake"),
      fireAt: new Date(fireAtIso).toISOString(),
      reason,
      createdAt: this.clock.nowIso(),
    };
    this.wakeups.set(w.id, w);
    return w;
  }
  async get(id: string): Promise<Wakeup | undefined> {
    return this.wakeups.get(id);
  }
  async remove(id: string): Promise<boolean> {
    return this.wakeups.delete(id);
  }
  async list(): Promise<Wakeup[]> {
    return [...this.wakeups.values()].sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  }
}

function rowToWakeup(row: D1Row): Wakeup {
  return {
    id: str(row.id, "wakeups.id"),
    fireAt: str(row.fire_at, "wakeups.fire_at"),
    reason: str(row.reason, "wakeups.reason"),
    createdAt: str(row.created_at, "wakeups.created_at"),
  };
}

/** D1-backed wake-ups. Same interface, real persistence. */
export class D1WakeupsRepo implements WakeupsStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
  ) {}

  async add(fireAtIso: string, reason: string): Promise<Wakeup> {
    const w: Wakeup = {
      id: newId("wake"),
      fireAt: new Date(fireAtIso).toISOString(),
      reason,
      createdAt: this.clock.nowIso(),
    };
    await this.db
      .prepare(`INSERT INTO wakeups (id, fire_at, reason, created_at) VALUES (?, ?, ?, ?)`)
      .bind(w.id, w.fireAt, w.reason, w.createdAt)
      .run();
    return w;
  }

  async get(id: string): Promise<Wakeup | undefined> {
    const row = await this.db.prepare(`SELECT * FROM wakeups WHERE id = ?`).bind(id).first<D1Row>();
    return row ? rowToWakeup(row) : undefined;
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.db.prepare(`DELETE FROM wakeups WHERE id = ?`).bind(id).run();
    return res.changes > 0;
  }

  async list(): Promise<Wakeup[]> {
    const res = await this.db.prepare(`SELECT * FROM wakeups ORDER BY fire_at ASC`).all<D1Row>();
    return res.results.map(rowToWakeup);
  }
}
