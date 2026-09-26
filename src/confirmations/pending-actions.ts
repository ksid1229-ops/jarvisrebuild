import type { Clock } from "../clock.js";
import { hashArgs, newId } from "../ids.js";
import type { PendingAction } from "../types.js";

export const CONFIRMATION_TTL_MS = 10 * 60 * 1000; // ~10 minutes, single-use

export class PendingActionsRepo {
  private readonly actions = new Map<string, PendingAction>();
  constructor(private readonly clock: Clock) {}

  async create(input: {
    tool: string;
    args: unknown;
    summary: string;
    ownerId: string;
    /** The turn/event that created it. A pending action cannot be confirmed within the same event. */
    creatingEventId: string;
  }): Promise<PendingAction> {
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

  get(id: string): PendingAction | undefined {
    return this.actions.get(id);
  }

  /**
   * Find a pending (unconfirmed) action that matches this tool + exact args for
   * this owner. Used by the gate to avoid duplicating a confirmation request.
   */
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

  /**
   * Confirm an action by id. Code checks ONLY: it exists, is this owner's, is
   * still pending, and is not expired. It does NOT read Sid's words — the model
   * (or a structured tap) decides that "yes" meant confirm and calls this.
   * Returns the action if it can now execute, or throws with the reason.
   */
  confirm(id: string, ownerId: string, currentEventId: string): PendingAction {
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

  cancel(id: string, ownerId: string): PendingAction {
    const a = this.actions.get(id);
    if (!a) throw new ConfirmError("no such pending action");
    if (a.ownerId !== ownerId) throw new ConfirmError("that pending action is not yours");
    a.status = "cancelled";
    return a;
  }

  markExecuted(id: string): void {
    const a = this.actions.get(id);
    if (a) a.status = "executed";
  }
}

export class ConfirmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmError";
  }
}
