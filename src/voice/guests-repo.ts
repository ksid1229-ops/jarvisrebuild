import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { str } from "../persistence/d1.js";

export interface Guest {
  id: string;
  name: string;
  phone: string;
  pinHash: string;
  /** Free-text description of what this guest may access. Passed to the guest prompt as-is. */
  access: string;
  expiresAt: string;
  createdAt: string;
}

export interface CreateGuestInput {
  name: string;
  phone: string;
  pinHash: string;
  access: string;
  expiresAt: string;
}

export interface GuestsStore {
  create(input: CreateGuestInput): Promise<Guest>;
  revoke(id: string): Promise<boolean>;
  get(id: string): Promise<Guest | undefined>;
  /** An active (non-expired) guest for a phone number, if any. */
  activeByPhone(phone: string): Promise<Guest | undefined>;
  list(): Promise<Guest[]>;
}

export class GuestsRepo implements GuestsStore {
  private readonly guests = new Map<string, Guest>();
  constructor(private readonly clock: Clock) {}

  async create(input: CreateGuestInput): Promise<Guest> {
    const g: Guest = {
      id: newId("guest"),
      name: input.name,
      phone: input.phone,
      pinHash: input.pinHash,
      access: input.access,
      expiresAt: input.expiresAt,
      createdAt: this.clock.nowIso(),
    };
    this.guests.set(g.id, g);
    return g;
  }

  async revoke(id: string): Promise<boolean> {
    return this.guests.delete(id);
  }

  async get(id: string): Promise<Guest | undefined> {
    return this.guests.get(id);
  }

  async activeByPhone(phone: string): Promise<Guest | undefined> {
    const now = this.clock.nowMs();
    for (const g of this.guests.values()) {
      if (g.phone === phone && new Date(g.expiresAt).getTime() > now) return g;
    }
    return undefined;
  }

  async list(): Promise<Guest[]> {
    return [...this.guests.values()];
  }
}

function rowToGuest(row: D1Row): Guest {
  return {
    id: str(row.id, "guests.id"),
    name: str(row.name, "guests.name"),
    phone: str(row.phone, "guests.phone"),
    pinHash: str(row.pin_hash, "guests.pin_hash"),
    access: str(row.access, "guests.access"),
    expiresAt: str(row.expires_at, "guests.expires_at"),
    createdAt: str(row.created_at, "guests.created_at"),
  };
}

/** D1-backed guests. Same interface, real persistence. */
export class D1GuestsRepo implements GuestsStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
  ) {}

  async create(input: CreateGuestInput): Promise<Guest> {
    const g: Guest = {
      id: newId("guest"),
      name: input.name,
      phone: input.phone,
      pinHash: input.pinHash,
      access: input.access,
      expiresAt: input.expiresAt,
      createdAt: this.clock.nowIso(),
    };
    await this.db
      .prepare(
        `INSERT INTO guests (id, name, phone, pin_hash, access, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(g.id, g.name, g.phone, g.pinHash, g.access, g.expiresAt, g.createdAt)
      .run();
    return g;
  }

  async revoke(id: string): Promise<boolean> {
    const res = await this.db.prepare(`DELETE FROM guests WHERE id = ?`).bind(id).run();
    return res.changes > 0;
  }

  async get(id: string): Promise<Guest | undefined> {
    const row = await this.db.prepare(`SELECT * FROM guests WHERE id = ?`).bind(id).first<D1Row>();
    return row ? rowToGuest(row) : undefined;
  }

  async activeByPhone(phone: string): Promise<Guest | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM guests WHERE phone = ? AND expires_at > ?`)
      .bind(phone, this.clock.nowIso())
      .first<D1Row>();
    return row ? rowToGuest(row) : undefined;
  }

  async list(): Promise<Guest[]> {
    const res = await this.db.prepare(`SELECT * FROM guests`).all<D1Row>();
    return res.results.map(rowToGuest);
  }
}
