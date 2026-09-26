import type { Clock } from "../clock.js";
import { newId } from "../ids.js";

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

export class GuestsRepo {
  private readonly guests = new Map<string, Guest>();
  constructor(private readonly clock: Clock) {}

  create(input: { name: string; phone: string; pinHash: string; access: string; expiresAt: string }): Guest {
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

  revoke(id: string): boolean {
    return this.guests.delete(id);
  }

  get(id: string): Guest | undefined {
    return this.guests.get(id);
  }

  /** An active (non-expired) guest for a phone number, if any. */
  activeByPhone(phone: string): Guest | undefined {
    const now = this.clock.nowMs();
    for (const g of this.guests.values()) {
      if (g.phone === phone && new Date(g.expiresAt).getTime() > now) return g;
    }
    return undefined;
  }

  list(): Guest[] {
    return [...this.guests.values()];
  }
}
