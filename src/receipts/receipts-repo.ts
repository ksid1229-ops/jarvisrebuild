import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { bool, str } from "../persistence/d1.js";
import type { Receipt, Trigger } from "../types.js";

export interface LogInput {
  tool: string;
  input: unknown;
  result: unknown;
  trigger: Trigger;
  performed: boolean;
  status: string;
}

export interface ReceiptsStore {
  log(input: LogInput): Promise<Receipt>;
  /** receipts_query: what did you do in this window? */
  query(opts?: { fromIso?: string; toIso?: string; tool?: string }): Promise<Receipt[]>;
  all(): Promise<Receipt[]>;
}

/**
 * The tool-call logger (Phase 1) and the source of Receipts (Phase 4). EVERY
 * tool call is recorded: time, tool, input, result, what triggered it, whether
 * it actually performed, and a status. A receipt code writes is evidence; a
 * receipt the model writes would only be a claim.
 */
export class ReceiptsRepo implements ReceiptsStore {
  private readonly receipts: Receipt[] = [];
  constructor(private readonly clock: Clock) {}

  async log(input: LogInput): Promise<Receipt> {
    const r: Receipt = {
      id: newId("rcpt"),
      at: this.clock.nowIso(),
      tool: input.tool,
      inputJson: safeJson(input.input),
      resultJson: safeJson(input.result),
      trigger: input.trigger,
      performed: input.performed,
      status: input.status,
    };
    this.receipts.push(r);
    return r;
  }

  async query(opts: { fromIso?: string; toIso?: string; tool?: string } = {}): Promise<Receipt[]> {
    const from = opts.fromIso ? new Date(opts.fromIso).getTime() : -Infinity;
    const to = opts.toIso ? new Date(opts.toIso).getTime() : Infinity;
    return this.receipts.filter((r) => {
      const t = new Date(r.at).getTime();
      if (t < from || t > to) return false;
      if (opts.tool && r.tool !== opts.tool) return false;
      return true;
    });
  }

  async all(): Promise<Receipt[]> {
    return [...this.receipts];
  }
}

function rowToReceipt(row: D1Row): Receipt {
  return {
    id: str(row.id, "receipts.id"),
    at: str(row.at, "receipts.at"),
    tool: str(row.tool, "receipts.tool"),
    inputJson: str(row.input_json, "receipts.input_json"),
    resultJson: str(row.result_json, "receipts.result_json"),
    trigger: str(row.trigger, "receipts.trigger") as Trigger,
    performed: bool(row.performed, "receipts.performed"),
    status: str(row.status, "receipts.status"),
  };
}

/** D1-backed receipts. Same interface, same semantics, real persistence. */
export class D1ReceiptsRepo implements ReceiptsStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
  ) {}

  async log(input: LogInput): Promise<Receipt> {
    const r: Receipt = {
      id: newId("rcpt"),
      at: this.clock.nowIso(),
      tool: input.tool,
      inputJson: safeJson(input.input),
      resultJson: safeJson(input.result),
      trigger: input.trigger,
      performed: input.performed,
      status: input.status,
    };
    await this.db
      .prepare(
        `INSERT INTO receipts (id, at, tool, input_json, result_json, trigger, performed, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(r.id, r.at, r.tool, r.inputJson, r.resultJson, r.trigger, r.performed ? 1 : 0, r.status)
      .run();
    return r;
  }

  async query(opts: { fromIso?: string; toIso?: string; tool?: string } = {}): Promise<Receipt[]> {
    // ISO instants compare lexicographically = chronologically.
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.fromIso) {
      clauses.push("at >= ?");
      params.push(opts.fromIso);
    }
    if (opts.toIso) {
      clauses.push("at <= ?");
      params.push(opts.toIso);
    }
    if (opts.tool) {
      clauses.push("tool = ?");
      params.push(opts.tool);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.db.prepare(`SELECT * FROM receipts ${where} ORDER BY rowid ASC`).bind(...params).all<D1Row>();
    return res.results.map(rowToReceipt);
  }

  async all(): Promise<Receipt[]> {
    const res = await this.db.prepare(`SELECT * FROM receipts ORDER BY rowid ASC`).all<D1Row>();
    return res.results.map(rowToReceipt);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify(String(v));
  }
}
