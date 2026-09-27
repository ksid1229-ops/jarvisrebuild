/**
 * School evidence store (D1 table school_evidence). One row per observation
 * batch: the full canonical body is kept so extractors can be re-run later
 * without asking the device to re-send anything.
 */
import type { D1Db, D1Row } from "../persistence/d1.js";
import { num, optStr, str } from "../persistence/d1.js";

export interface EvidenceRow {
  batchId: string;
  host: string;
  readId: string;
  startedAt: string;
  courseId: string | null;
  courseName: string | null;
  enrollmentComplete: boolean;
  /** The full canonical observation body, exactly as verified. */
  bodyJson: string;
  receivedAt: string;
  outcome: "good" | "failed";
}

export function rowToEvidence(row: D1Row): EvidenceRow {
  return {
    batchId: str(row.batch_id, "evidence.batch_id"),
    host: str(row.host, "evidence.host"),
    readId: str(row.read_id, "evidence.read_id"),
    startedAt: str(row.started_at, "evidence.started_at"),
    courseId: optStr(row.course_id, "evidence.course_id"),
    courseName: optStr(row.course_name, "evidence.course_name"),
    enrollmentComplete: num(row.enrollment_complete, "evidence.enrollment_complete") === 1,
    bodyJson: str(row.body_json, "evidence.body_json"),
    receivedAt: str(row.received_at, "evidence.received_at"),
    outcome: str(row.outcome, "evidence.outcome") as EvidenceRow["outcome"],
  };
}

export class EvidenceStore {
  constructor(private readonly db: D1Db) {}

  async insert(row: Omit<EvidenceRow, "receivedAt">, receivedAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO school_evidence
         (batch_id, host, read_id, started_at, course_id, course_name,
          enrollment_complete, body_json, received_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.batchId, row.host, row.readId, row.startedAt, row.courseId, row.courseName,
        row.enrollmentComplete ? 1 : 0, row.bodyJson, receivedAt, row.outcome,
      )
      .run();
  }

  /** Latest good batch per course (host-failure rows have no course and are skipped). */
  async latestGoodPerCourse(): Promise<EvidenceRow[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM school_evidence e
         WHERE outcome = 'good' AND course_id IS NOT NULL
           AND received_at = (
             SELECT MAX(received_at) FROM school_evidence
             WHERE outcome = 'good' AND host = e.host AND course_id = e.course_id
           )
         ORDER BY course_name`,
      )
      .all<D1Row>();
    return res.results.map(rowToEvidence);
  }

  /**
   * Everything needed to diff a course since a moment: every batch received
   * after it (any outcome), plus the newest GOOD batch at or before it as the
   * baseline. Newest first. No row cap — a busy week never hides a change.
   */
  async historyForCourseSince(host: string, courseId: string, sinceIso: string): Promise<{ rows: EvidenceRow[]; hasBaseline: boolean }> {
    const after = await this.db
      .prepare(
        `SELECT * FROM school_evidence
         WHERE host = ? AND course_id = ? AND received_at > ? ORDER BY received_at DESC`,
      )
      .bind(host, courseId, sinceIso)
      .all<D1Row>();
    const baseline = await this.db
      .prepare(
        `SELECT * FROM school_evidence
         WHERE host = ? AND course_id = ? AND received_at <= ? AND outcome = 'good'
         ORDER BY received_at DESC LIMIT 1`,
      )
      .bind(host, courseId, sinceIso)
      .first<D1Row>();
    const rows = after.results.map(rowToEvidence);
    if (baseline) rows.push(rowToEvidence(baseline));
    return { rows, hasBaseline: !!baseline };
  }

  async receivedAfter(sinceIso: string): Promise<EvidenceRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM school_evidence WHERE received_at > ? ORDER BY received_at`)
      .bind(sinceIso)
      .all<D1Row>();
    return res.results.map(rowToEvidence);
  }

  /** Latest batch of any outcome per course: the freshness dashboard. */
  async latestPerCourse(): Promise<EvidenceRow[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM school_evidence e
         WHERE course_id IS NOT NULL
           AND received_at = (
             SELECT MAX(received_at) FROM school_evidence
             WHERE host = e.host AND course_id = e.course_id
           )
         ORDER BY course_name`,
      )
      .all<D1Row>();
    return res.results.map(rowToEvidence);
  }
}
