/**
 * School request queue (D1 table school_requests, see migrations/0002).
 * Jarvis-side requests that the browser extension pulls on its own schedule
 * — the pull channel's queue. Vocabulary matches the schema CHECKs exactly.
 */
import type { D1Db, D1Row } from "../persistence/d1.js";
import { optStr, str } from "../persistence/d1.js";

export type SchoolRequestStatus = "queued" | "delivered" | "succeeded" | "failed" | "expired";
export type SchoolRequestAction = "sync_now" | "open_item" | "notify";

export interface SchoolRequest {
  requestId: string;
  action: SchoolRequestAction;
  argsJson: string;
  status: SchoolRequestStatus;
  resultJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export function rowToSchoolRequest(row: D1Row): SchoolRequest {
  return {
    requestId: str(row.id, "requests.id"),
    action: str(row.action, "requests.action") as SchoolRequestAction,
    argsJson: str(row.args_json, "requests.args_json"),
    status: str(row.status, "requests.status") as SchoolRequestStatus,
    resultJson: optStr(row.result_json, "requests.result_json"),
    createdAt: str(row.created_at, "requests.created_at"),
    updatedAt: str(row.updated_at, "requests.updated_at"),
  };
}

export class SchoolRequests {
  constructor(private readonly db: D1Db) {}

  async enqueue(requestId: string, action: SchoolRequestAction, args: unknown, createdAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO school_requests (id, action, args_json, status, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .bind(requestId, action, JSON.stringify(args), createdAt, createdAt)
      .run();
  }

  /** Oldest-first queued requests for the pull channel. */
  async queued(limit = 10): Promise<SchoolRequest[]> {
    const res = await this.db
      .prepare(`SELECT * FROM school_requests WHERE status = 'queued' ORDER BY created_at LIMIT ?`)
      .bind(limit)
      .all<D1Row>();
    return res.results.map(rowToSchoolRequest);
  }

  async markDelivered(requestId: string, at: string): Promise<void> {
    await this.db
      .prepare(`UPDATE school_requests SET status = 'delivered', updated_at = ? WHERE id = ?`)
      .bind(at, requestId)
      .run();
  }

  async complete(requestId: string, result: unknown, at: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE school_requests SET status = 'succeeded', result_json = ?, updated_at = ?
         WHERE id = ? AND status != 'succeeded'`,
      )
      .bind(JSON.stringify(result), at, requestId)
      .run();
    return res.changes > 0;
  }

  async queuedCount(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM school_requests WHERE status = 'queued'`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}
