import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { num, optStr, str } from "../persistence/d1.js";

/**
 * The PC job queue (Sid's decision, 2026-09-26: Jarvis may do literally
 * anything on his PC; when the PC is off, work is QUEUED and runs when the PC
 * checks in). Jarvis enqueues; the Windows PC agent (apps/pc-agent) pulls with
 * a bearer token, executes, and posts results. Every step is a receipt.
 *
 * Kinds are deliberately few and literal — shell, open_url, browser — and the
 * ARGS for each are validated when enqueued (that is validation, not judgment:
 * a shell job needs a command; a URL job needs a URL).
 */
export type PcJobKind = "shell" | "open_url" | "browser";
export const PC_JOB_KINDS: readonly PcJobKind[] = ["shell", "open_url", "browser"];

export type PcJobStatus = "queued" | "delivered" | "done" | "failed";

export interface PcJob {
  id: string;
  kind: PcJobKind;
  argsJson: string;
  status: PcJobStatus;
  createdAt: string;
  deliveredAt: string | null;
  finishedAt: string | null;
  resultJson: string | null;
  error: string | null;
}

export interface PcJobsStore {
  enqueue(kind: PcJobKind, args: Record<string, unknown>): Promise<PcJob>;
  /** Oldest queued first; marks them delivered so two pulls never overlap. */
  next(limit: number): Promise<PcJob[]>;
  /** Record what the PC actually did. Unknown id => false (said so by caller). */
  complete(id: string, result: { ok: boolean; result?: unknown; error?: string }): Promise<boolean>;
  pendingCount(): Promise<number>;
  get(id: string): Promise<PcJob | undefined>;
  all(): Promise<PcJob[]>;
}

export class InMemoryPcJobsRepo implements PcJobsStore {
  private readonly rows: PcJob[] = [];

  async enqueue(kind: PcJobKind, args: Record<string, unknown>): Promise<PcJob> {
    const job: PcJob = {
      id: newId("pcjob"),
      kind,
      argsJson: JSON.stringify(args),
      status: "queued",
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      finishedAt: null,
      resultJson: null,
      error: null,
    };
    this.rows.push(job);
    return job;
  }
  async next(limit: number): Promise<PcJob[]> {
    const due = this.rows.filter((j) => j.status === "queued").sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).slice(0, limit);
    for (const j of due) j.status = "delivered";
    return due;
  }
  async complete(id: string, result: { ok: boolean; result?: unknown; error?: string }): Promise<boolean> {
    const j = this.rows.find((r) => r.id === id);
    if (!j) return false;
    j.status = result.ok ? "done" : "failed";
    j.finishedAt = new Date().toISOString();
    j.resultJson = result.result === undefined ? null : JSON.stringify(result.result);
    j.error = result.error ?? null;
    return true;
  }
  async pendingCount(): Promise<number> {
    return this.rows.filter((j) => j.status === "queued").length;
  }
  async get(id: string): Promise<PcJob | undefined> {
    return this.rows.find((r) => r.id === id);
  }
  async all(): Promise<PcJob[]> {
    return [...this.rows];
  }
}

function rowToJob(row: D1Row): PcJob {
  return {
    id: str(row.id, "pc_jobs.id"),
    kind: str(row.kind, "pc_jobs.kind") as PcJobKind,
    argsJson: str(row.args_json, "pc_jobs.args_json"),
    status: str(row.status, "pc_jobs.status") as PcJobStatus,
    createdAt: str(row.created_at, "pc_jobs.created_at"),
    deliveredAt: optStr(row.delivered_at, "pc_jobs.delivered_at"),
    finishedAt: optStr(row.finished_at, "pc_jobs.finished_at"),
    resultJson: optStr(row.result_json, "pc_jobs.result_json"),
    error: optStr(row.error, "pc_jobs.error"),
  };
}

export class D1PcJobsRepo implements PcJobsStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
  ) {}

  async enqueue(kind: PcJobKind, args: Record<string, unknown>): Promise<PcJob> {
    const job: PcJob = {
      id: newId("pcjob"),
      kind,
      argsJson: JSON.stringify(args),
      status: "queued",
      createdAt: this.clock.nowIso(),
      deliveredAt: null,
      finishedAt: null,
      resultJson: null,
      error: null,
    };
    await this.db
      .prepare(`INSERT INTO pc_jobs (id, kind, args_json, status, created_at) VALUES (?, ?, ?, 'queued', ?)`)
      .bind(job.id, job.kind, job.argsJson, job.createdAt)
      .run();
    return job;
  }

  async next(limit: number): Promise<PcJob[]> {
    // Single-puller design (Sid's one PC). The conditional UPDATE makes a
    // double-delivery require a race that also fails the status check.
    const res = await this.db
      .prepare(`SELECT * FROM pc_jobs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .bind(limit)
      .all<D1Row>();
    const now = this.clock.nowIso();
    const out: PcJob[] = [];
    for (const row of res.results) {
      const job = rowToJob(row);
      const upd = await this.db
        .prepare(`UPDATE pc_jobs SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'queued'`)
        .bind(now, job.id)
        .run();
      if (upd.success && upd.changes === 1) out.push({ ...job, status: "delivered", deliveredAt: now });
    }
    return out;
  }

  async complete(id: string, result: { ok: boolean; result?: unknown; error?: string }): Promise<boolean> {
    const upd = await this.db
      .prepare(
        `UPDATE pc_jobs SET status = ?, finished_at = ?, result_json = ?, error = ?
         WHERE id = ? AND status IN ('queued','delivered')`,
      )
      .bind(result.ok ? "done" : "failed", this.clock.nowIso(), result.result === undefined ? null : JSON.stringify(result.result), result.error ?? null, id)
      .run();
    return upd.success && upd.changes === 1;
  }

  async pendingCount(): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM pc_jobs WHERE status = 'queued'`).first<D1Row>();
    return row ? num(row.n, "pc_jobs count") : 0;
  }

  async get(id: string): Promise<PcJob | undefined> {
    const row = await this.db.prepare(`SELECT * FROM pc_jobs WHERE id = ?`).bind(id).first<D1Row>();
    return row ? rowToJob(row) : undefined;
  }

  async all(): Promise<PcJob[]> {
    const res = await this.db.prepare(`SELECT * FROM pc_jobs ORDER BY rowid ASC`).all<D1Row>();
    return res.results.map(rowToJob);
  }
}
