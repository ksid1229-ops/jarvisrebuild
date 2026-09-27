import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { num, optStr, str } from "../persistence/d1.js";

/**
 * Inbound email storage. Cloudflare Email Routing hands the Worker each raw
 * message; the parsed record lands here and the untouched .eml goes to the
 * ARCHIVE bucket. email_list / email_read serve the brain from this store.
 */
export interface StoredEmail {
  id: string;
  fromAddr: string;
  toAddr: string;
  subject: string;
  textBody: string;
  receivedAt: string;
  r2Key: string | null;
  reviewedAt: string | null;
}

export interface EmailsStore {
  insert(email: Omit<StoredEmail, "id" | "receivedAt" | "reviewedAt"> & { receivedAt: string }): Promise<StoredEmail>;
  get(id: string): Promise<StoredEmail | undefined>;
  /** Newest first. `sinceIso` is a lower bound on received_at. */
  recent(sinceIso?: string): Promise<StoredEmail[]>;
  markReviewed(id: string, atIso: string): Promise<void>;
  all(): Promise<StoredEmail[]>;
}

export class InMemoryEmailsRepo implements EmailsStore {
  private readonly rows: StoredEmail[] = [];

  async insert(email: Omit<StoredEmail, "id" | "reviewedAt">): Promise<StoredEmail> {
    const row: StoredEmail = { ...email, id: newId("email"), reviewedAt: null };
    this.rows.push(row);
    return row;
  }
  async get(id: string): Promise<StoredEmail | undefined> {
    return this.rows.find((e) => e.id === id);
  }
  async recent(sinceIso?: string): Promise<StoredEmail[]> {
    return this.rows
      .filter((e) => (sinceIso ? e.receivedAt >= sinceIso : true))
      .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  }
  async markReviewed(id: string, atIso: string): Promise<void> {
    const row = this.rows.find((e) => e.id === id);
    if (row) row.reviewedAt = atIso;
  }
  async all(): Promise<StoredEmail[]> {
    return [...this.rows];
  }
}

function rowToEmail(row: D1Row): StoredEmail {
  return {
    id: str(row.id, "emails.id"),
    fromAddr: str(row.from_addr, "emails.from_addr"),
    toAddr: str(row.to_addr, "emails.to_addr"),
    subject: str(row.subject, "emails.subject"),
    textBody: str(row.text_body, "emails.text_body"),
    receivedAt: str(row.received_at, "emails.received_at"),
    r2Key: optStr(row.r2_key, "emails.r2_key"),
    reviewedAt: optStr(row.reviewed_at, "emails.reviewed_at"),
  };
}

export class D1EmailsRepo implements EmailsStore {
  constructor(private readonly db: D1Db) {}

  async insert(email: Omit<StoredEmail, "id" | "reviewedAt">): Promise<StoredEmail> {
    const row: StoredEmail = { ...email, id: newId("email"), reviewedAt: null };
    await this.db
      .prepare(
        `INSERT INTO emails (id, from_addr, to_addr, subject, text_body, received_at, r2_key, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(row.id, row.fromAddr, row.toAddr, row.subject, row.textBody, row.receivedAt, row.r2Key)
      .run();
    return row;
  }

  async get(id: string): Promise<StoredEmail | undefined> {
    const row = await this.db.prepare(`SELECT * FROM emails WHERE id = ?`).bind(id).first<D1Row>();
    return row ? rowToEmail(row) : undefined;
  }

  async recent(sinceIso?: string): Promise<StoredEmail[]> {
    const res = sinceIso
      ? await this.db.prepare(`SELECT * FROM emails WHERE received_at >= ? ORDER BY received_at DESC, rowid DESC`).bind(sinceIso).all<D1Row>()
      : await this.db.prepare(`SELECT * FROM emails ORDER BY received_at DESC, rowid DESC`).all<D1Row>();
    return res.results.map(rowToEmail);
  }

  async markReviewed(id: string, atIso: string): Promise<void> {
    await this.db.prepare(`UPDATE emails SET reviewed_at = ? WHERE id = ?`).bind(atIso, id).run();
  }

  async all(): Promise<StoredEmail[]> {
    const res = await this.db.prepare(`SELECT * FROM emails ORDER BY rowid ASC`).all<D1Row>();
    return res.results.map(rowToEmail);
  }
}

/** Never used silently; exists so the backup can size the table. */
export async function countEmails(db: D1Db): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM emails`).first<D1Row>();
  return row ? num(row.n, "emails count") : 0;
}
