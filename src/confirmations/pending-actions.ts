import type { Clock } from "../clock.js";
import { hashArgs, newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { str } from "../persistence/d1.js";
import type { PendingAction } from "../types.js";

export const CONFIRMATION_TTL_MS = 10 * 60 * 1000; // ~10 minutes, single-use

export interface CreatePendingInput {
  tool: string;
  args: unknown;
  summary: string;
  ownerId: string;
  /** The turn/event that created it. A pending action cannot be confirmed within the same event. */
  creatingEventId: string;
}

export interface PendingStore {
  create(input: CreatePendingInput): Promise<PendingAction>;
  get(id: string): Promise<PendingAction | undefined>;
  /**
   * Find a pending (unconfirmed) action that matches this tool + exact args for
   * this owner. Used by the gate to avoid duplicating a confirmation request.
   */
  findPendingMatch(tool: string, args: unknown, ownerId: string): Promise<PendingAction | undefined>;
  /** Pure check on an action object (no storage read), so it stays sync. */
  isExpired(a: PendingAction): boolean;
  /**
   * Confirm an action by id. Code checks ONLY: it exists, is this owner's, is
   * still pending, and is not expired. It does NOT read Sid's words — the model
   * (or a structured tap) decides that "yes" meant confirm and calls this.
   * Returns the action if it can now execute, or throws with the reason.
   */
  confirm(id: string, ownerId: string, currentEventId: string): Promise<PendingAction>;
  cancel(id: string, ownerId: string): Promise<PendingAction>;
  markExecuted(id: string): Promise<void>;
}

export class PendingActionsRepo implements PendingStore {
  private readonly actions = new Map<string, PendingAction>();
  constructor(private readonly clock: Clock) {}

  async create(input: CreatePendingInput): Promise<PendingAction> {
    const now = this.clock.nowMs();
    const action: PendingAction = {
      id: newId("pending"),
      tool: input.tool,
      argsJson: JSON.stringify(input.args),
      argsHash: await hashArgs(input.args),
      summary: input.summary,
      ownerId: input.ownerId,
      creatingEventId: input.creatingEventId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CONFIRMATION_TTL_MS).toISOString(),
      status: "pending",
    };
    this.actions.set(action.id, action);
    return action;
  }

  async get(id: string): Promise<PendingAction | undefined> {
    return this.actions.get(id);
  }

  async findPendingMatch(tool: string, args: unknown, ownerId: string): Promise<PendingAction | undefined> {
    const hash = await hashArgs(args);
    for (const a of this.actions.values()) {
      if (a.tool === tool && a.argsHash === hash && a.ownerId === ownerId && a.status === "pending") {
        if (!this.isExpired(a)) return a;
      }
    }
    return undefined;
  }

  isExpired(a: PendingAction): boolean {
    return new Date(a.expiresAt).getTime() <= this.clock.nowMs();
  }

  async confirm(id: string, ownerId: string, currentEventId: string): Promise<PendingAction> {
    const a = this.actions.get(id);
    if (!a) throw new ConfirmError("no such pending action");
    if (a.ownerId !== ownerId) throw new ConfirmError("that pending action is not yours");
    if (a.status !== "pending") throw new ConfirmError(`action is ${a.status}, not pending`);
    if (this.isExpired(a)) {
      a.status = "expired";
      throw new ConfirmError("that confirmation has expired");
    }
    if (a.creatingEventId === currentEventId) {
      // Fail closed: a confirmation must come from Sid's next message/tap, not the
      // same turn that requested it. The model cannot confirm its own action.
      throw new ConfirmError("a confirmation must come from Sid, not the same turn that requested it");
    }
    a.status = "confirmed";
    return a;
  }

  async cancel(id: string, ownerId: string): Promise<PendingAction> {
    const a = this.actions.get(id);
    if (!a) throw new ConfirmError("no such pending action");
    if (a.ownerId !== ownerId) throw new ConfirmError("that pending action is not yours");
    a.status = "cancelled";
    return a;
  }

  async markExecuted(id: string): Promise<void> {
    const a = this.actions.get(id);
    if (a) a.status = "executed";
  }
}

function rowToPending(row: D1Row): PendingAction {
  return {
    id: str(row.id, "pending_actions.id"),
    tool: str(row.tool, "pending_actions.tool"),
    argsJson: str(row.args_json, "pending_actions.args_json"),
    argsHash: str(row.args_hash, "pending_actions.args_hash"),
    summary: str(row.summary, "pending_actions.summary"),
    ownerId: str(row.owner_id, "pending_actions.owner_id"),
    creatingEventId: str(row.creating_event_id, "pending_actions.creating_event_id"),
    createdAt: str(row.created_at, "pending_actions.created_at"),
    expiresAt: str(row.expires_at, "pending_actions.expires_at"),
    status: str(row.status, "pending_actions.status") as PendingAction["status"],
  };
}

/** D1-backed pending actions. Same guards, same errors, real persistence. */
export class D1PendingActionsRepo implements PendingStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
  ) {}

  async create(input: CreatePendingInput): Promise<PendingAction> {
    const now = this.clock.nowMs();
    const action: PendingAction = {
      id: newId("pending"),
      tool: input.tool,
      argsJson: JSON.stringify(input.args),
      argsHash: await hashArgs(input.args),
      summary: input.summary,
      ownerId: input.ownerId,
      creatingEventId: input.creatingEventId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CONFIRMATION_TTL_MS).toISOString(),
      status: "pending",
    };
    await this.db
      .prepare(
        `INSERT INTO pending_actions (id, tool, args_json, args_hash, summary, owner_id,
         creating_event_id, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        action.id, action.tool, action.argsJson, action.argsHash, action.summary, action.ownerId,
        action.creatingEventId, action.createdAt, action.expiresAt, action.status,
      )
      .run();
    return action;
  }

  async get(id: string): Promise<PendingAction | undefined> {
    const row = await this.db.prepare(`SELECT * FROM pending_actions WHERE id = ?`).bind(id).first<D1Row>();
    return row ? rowToPending(row) : undefined;
  }

  async findPendingMatch(tool: string, args: unknown, ownerId: string): Promise<PendingAction | undefined> {
    const hash = await hashArgs(args);
    const res = await this.db
      .prepare(
        `SELECT * FROM pending_actions
         WHERE tool = ? AND args_hash = ? AND owner_id = ? AND status = 'pending'`,
      )
      .bind(tool, hash, ownerId)
      .all<D1Row>();
    for (const row of res.results) {
      const a = rowToPending(row);
      if (!this.isExpired(a)) return a;
    }
    return undefined;
  }

  isExpired(a: PendingAction): boolean {
    return new Date(a.expiresAt).getTime() <= this.clock.nowMs();
  }

  async confirm(id: string, ownerId: string, currentEventId: string): Promise<PendingAction> {
    const a = await this.get(id);
    if (!a) throw new ConfirmError("no such pending action");
    if (a.ownerId !== ownerId) throw new ConfirmError("that pending action is not yours");
    if (a.status !== "pending") throw new ConfirmError(`action is ${a.status}, not pending`);
    if (this.isExpired(a)) {
      await this.setStatus(id, "expired");
      throw new ConfirmError("that confirmation has expired");
    }
    if (a.creatingEventId === currentEventId) {
      throw new ConfirmError("a confirmation must come from Sid, not the same turn that requested it");
    }
    await this.setStatus(id, "confirmed");
    return { ...a, status: "confirmed" };
  }

  async cancel(id: string, ownerId: string): Promise<PendingAction> {
    const a = await this.get(id);
    if (!a) throw new ConfirmError("no such pending action");
    if (a.ownerId !== ownerId) throw new ConfirmError("that pending action is not yours");
    await this.setStatus(id, "cancelled");
    return { ...a, status: "cancelled" };
  }

  async markExecuted(id: string): Promise<void> {
    await this.setStatus(id, "executed");
  }

  private async setStatus(id: string, status: PendingAction["status"]): Promise<void> {
    await this.db.prepare(`UPDATE pending_actions SET status = ? WHERE id = ?`).bind(status, id).run();
  }
}

export class ConfirmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmError";
  }
}
