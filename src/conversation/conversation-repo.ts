import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { bool, num, str } from "../persistence/d1.js";
import type { Channel, StoredMessage } from "../types.js";

/**
 * Conversation store. Recent messages are kept in full; when the transcript
 * grows past a size cap (a system-protection limit, NOT a judgment about what
 * matters) code TRIGGERS a summary. The MODEL writes the summary text — code
 * never decides what to keep.
 *
 * The SAME store serves text and voice (brief: the first build kept two stores
 * with no bridge, so calls remembered nothing).
 */
export interface ConversationStore {
  append(role: "user" | "assistant", content: string, channel: Channel): Promise<StoredMessage>;
  /** All messages (any channel), oldest first; rollup summaries sort before live messages. */
  all(): Promise<StoredMessage[]>;
  /** Recent window for the model context. */
  recent(limit?: number): Promise<StoredMessage[]>;
  /** Literal search over past conversation, both Sid's and Jarvis's words. */
  literalSearch(query: string): Promise<StoredMessage[]>;
  /** Code decides ONLY that the transcript is too long, never what matters. */
  needsSummary(): Promise<boolean>;
  /**
   * Replace the oldest `count` messages with a single summary the MODEL wrote.
   * Returns the messages that were rolled up (so a caller can archive them).
   */
  applySummary(summaryText: string, count: number): Promise<StoredMessage[]>;
}

export class ConversationRepo implements ConversationStore {
  private readonly messages: StoredMessage[] = [];
  constructor(
    private readonly clock: Clock,
    /** Runaway cap: summarize when more than this many un-summarized messages exist. */
    private readonly summaryThreshold = 40,
  ) {}

  async append(role: "user" | "assistant", content: string, channel: Channel): Promise<StoredMessage> {
    const m: StoredMessage = {
      id: newId("msg"),
      role,
      content,
      channel,
      createdAt: this.clock.nowIso(),
    };
    this.messages.push(m);
    return m;
  }

  async all(): Promise<StoredMessage[]> {
    return [...this.messages];
  }

  async recent(limit = 30): Promise<StoredMessage[]> {
    return this.messages.slice(-limit);
  }

  async literalSearch(query: string): Promise<StoredMessage[]> {
    const q = query.toLowerCase();
    return this.messages.filter((m) => m.content.toLowerCase().includes(q));
  }

  async needsSummary(): Promise<boolean> {
    const unsummarized = this.messages.filter((m) => !m.isSummary).length;
    return unsummarized > this.summaryThreshold;
  }

  async applySummary(summaryText: string, count: number): Promise<StoredMessage[]> {
    const toRoll = this.messages.slice(0, count);
    const summary: StoredMessage = {
      id: newId("sum"),
      role: "assistant",
      content: summaryText,
      channel: "text",
      createdAt: this.clock.nowIso(),
      isSummary: true,
    };
    this.messages.splice(0, count, summary);
    return toRoll;
  }
}

function rowToMessage(row: D1Row): StoredMessage {
  const m: StoredMessage = {
    id: str(row.id, "messages.id"),
    role: str(row.role, "messages.role") as StoredMessage["role"],
    content: str(row.content, "messages.content"),
    channel: str(row.channel, "messages.channel") as Channel,
    createdAt: str(row.created_at, "messages.created_at"),
  };
  if (bool(row.is_summary, "messages.is_summary")) m.isSummary = true;
  return m;
}

/** D1-backed conversation store. Same interface, same ordering semantics. */
export class D1ConversationRepo implements ConversationStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
    private readonly summaryThreshold = 40,
  ) {}

  async append(role: "user" | "assistant", content: string, channel: Channel): Promise<StoredMessage> {
    const m: StoredMessage = {
      id: newId("msg"),
      role,
      content,
      channel,
      createdAt: this.clock.nowIso(),
    };
    await this.db
      .prepare(
        `INSERT INTO messages (id, role, content, channel, created_at, is_summary)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .bind(m.id, m.role, m.content, m.channel, m.createdAt)
      .run();
    return m;
  }

  async all(): Promise<StoredMessage[]> {
    // Summaries stand in for the oldest messages, so they sort first — the
    // same position applySummary splices them into in memory.
    const res = await this.db
      .prepare(`SELECT * FROM messages ORDER BY is_summary DESC, rowid ASC`)
      .all<D1Row>();
    return res.results.map(rowToMessage);
  }

  async recent(limit = 30): Promise<StoredMessage[]> {
    const res = await this.db
      .prepare(`SELECT * FROM messages ORDER BY is_summary DESC, rowid ASC`)
      .all<D1Row>();
    return res.results.map(rowToMessage).slice(-limit);
  }

  async literalSearch(query: string): Promise<StoredMessage[]> {
    const pattern = `%${query.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const res = await this.db
      .prepare(
        `SELECT * FROM messages WHERE lower(content) LIKE ? ESCAPE '\\'
         ORDER BY is_summary DESC, rowid ASC`,
      )
      .bind(pattern)
      .all<D1Row>();
    return res.results.map(rowToMessage);
  }

  async needsSummary(): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE is_summary = 0`)
      .first<D1Row>();
    return num(row?.n, "count") > this.summaryThreshold;
  }

  async applySummary(summaryText: string, count: number): Promise<StoredMessage[]> {
    const oldest = await this.db
      .prepare(`SELECT * FROM messages ORDER BY is_summary DESC, rowid ASC LIMIT ?`)
      .bind(count)
      .all<D1Row>();
    const toRoll = oldest.results.map(rowToMessage);
    for (const m of toRoll) {
      await this.db.prepare(`DELETE FROM messages WHERE id = ?`).bind(m.id).run();
    }
    const summary: StoredMessage = {
      id: newId("sum"),
      role: "assistant",
      content: summaryText,
      channel: "text",
      createdAt: this.clock.nowIso(),
      isSummary: true,
    };
    await this.db
      .prepare(
        `INSERT INTO messages (id, role, content, channel, created_at, is_summary)
         VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .bind(summary.id, summary.role, summary.content, summary.channel, summary.createdAt)
      .run();
    return toRoll;
  }
}
