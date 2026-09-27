import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { bool, num, optStr, str } from "../persistence/d1.js";
import type { Channel, StoredMessage } from "../types.js";

/**
 * Conversation store. The SAME store serves text and voice (the first build kept
 * two stores with no bridge, so calls remembered nothing).
 *
 * Two views of one table:
 *  - the CONTEXT view (context/recent): what the model sees each turn. When the
 *    transcript grows past a size cap (a system-protection limit, NOT a judgment
 *    about what matters) code TRIGGERS a summary; the MODEL writes it; the
 *    summary then stands in for the older messages in the context view.
 *  - the RECORD (all/get/search/since): every message ever stored. Summarizing
 *    never deletes a row — it only marks it rolled_up — so history_search and
 *    memory reviews still see every word, including what Jarvis said on calls.
 */
export interface AppendMeta {
  /** True when Sid forwarded this text (not his own words). Set by code from the channel. */
  forwarded?: boolean;
  /** Channel-level id, e.g. telegram:<chat>:<msg>. */
  sourceRef?: string;
}

export interface HistoryQuery {
  /** Literal text to find (case-insensitive substring). */
  query: string;
  /** Inclusive RFC3339 bounds. */
  since?: string;
  until?: string;
  channel?: Channel;
  /** How many matches to return, newest first. The model chooses; omitted = every match. */
  limit?: number;
  /** Skip this many newest matches first (paging). Omitted = 0. */
  offset?: number;
}

export interface HistoryResult {
  /** Newest first. Never includes summaries: this is the literal record. */
  results: StoredMessage[];
  /** How many messages matched in total, so a limit never hides the size of the answer. */
  totalMatches: number;
  /** Coverage: how many real messages are stored and the oldest one's time. */
  storedMessages: number;
  earliestStored: string | null;
}

export interface ReviewWindow {
  /** Oldest first, non-summary messages strictly after the cursor. */
  messages: StoredMessage[];
  /** Messages after the window that did not fit the cap (they wait for the next run). */
  deferred: number;
}

export interface ConversationStore {
  append(role: "user" | "assistant", content: string, channel: Channel, meta?: AppendMeta): Promise<StoredMessage>;
  get(id: string): Promise<StoredMessage | undefined>;
  /** The record: every stored message (live, rolled up, summaries) in insertion order. */
  all(): Promise<StoredMessage[]>;
  /** The context view: the live summary first, then messages not yet rolled up. */
  context(): Promise<StoredMessage[]>;
  /** Tail of the context view. */
  recent(limit?: number): Promise<StoredMessage[]>;
  /** Literal search over the record, both Sid's and Jarvis's words, text and voice. */
  search(q: HistoryQuery): Promise<HistoryResult>;
  /** Messages after a cursor (for memory reviews), capped, reporting what was deferred. */
  since(afterIso: string | null, cap: number): Promise<ReviewWindow>;
  /** Code decides ONLY that the context is too long, never what matters. */
  needsSummary(): Promise<boolean>;
  /**
   * Replace the oldest `count` context messages with a summary the MODEL wrote.
   * The replaced rows are kept (rolled_up), never deleted. Returns them.
   */
  applySummary(summaryText: string, count: number): Promise<StoredMessage[]>;
}

function matchesQuery(m: StoredMessage, q: HistoryQuery, from: number, to: number, needle: string): boolean {
  if (m.isSummary) return false;
  if (q.channel && m.channel !== q.channel) return false;
  const t = new Date(m.createdAt).getTime();
  if (t < from || t > to) return false;
  return m.content.toLowerCase().includes(needle);
}

function bounds(q: HistoryQuery): { from: number; to: number } {
  return {
    from: q.since ? new Date(q.since).getTime() : -Infinity,
    to: q.until ? new Date(q.until).getTime() : Infinity,
  };
}

/**
 * Cap a review window without splitting a timestamp. The cursor is a timestamp,
 * so if the cap falls between two messages sharing one instant, that whole
 * instant moves to the next run. If the window would then be EMPTY (every
 * message up to the cap shares one instant), the window instead grows past the
 * cap to cover that whole instant — otherwise those messages would be skipped
 * forever. `after` must hold every message through the cap's instant.
 */
function capWindow(after: StoredMessage[], cap: number): ReviewWindow {
  if (after.length <= cap) return { messages: after, deferred: 0 };
  const boundary = after[cap]!.createdAt;
  let included = after.slice(0, cap).filter((m) => m.createdAt !== boundary);
  if (included.length === 0) included = after.filter((m) => m.createdAt <= boundary);
  return { messages: included, deferred: after.length - included.length };
}

export class ConversationRepo implements ConversationStore {
  private readonly messages: StoredMessage[] = [];
  constructor(
    private readonly clock: Clock,
    /** Runaway cap: summarize when more than this many live messages are in context. */
    private readonly summaryThreshold = 40,
  ) {}

  async append(role: "user" | "assistant", content: string, channel: Channel, meta: AppendMeta = {}): Promise<StoredMessage> {
    const m: StoredMessage = {
      id: newId("msg"),
      role,
      content,
      channel,
      createdAt: this.clock.nowIso(),
    };
    if (meta.forwarded) m.forwarded = true;
    if (meta.sourceRef) m.sourceRef = meta.sourceRef;
    this.messages.push(m);
    return m;
  }

  async get(id: string): Promise<StoredMessage | undefined> {
    return this.messages.find((m) => m.id === id);
  }

  async all(): Promise<StoredMessage[]> {
    return [...this.messages];
  }

  async context(): Promise<StoredMessage[]> {
    const live = this.messages.filter((m) => !m.rolledUp);
    return [...live.filter((m) => m.isSummary), ...live.filter((m) => !m.isSummary)];
  }

  async recent(limit = 30): Promise<StoredMessage[]> {
    return (await this.context()).slice(-limit);
  }

  async search(q: HistoryQuery): Promise<HistoryResult> {
    const { from, to } = bounds(q);
    const needle = q.query.toLowerCase();
    const real = this.messages.filter((m) => !m.isSummary);
    const matches = real.filter((m) => matchesQuery(m, q, from, to, needle)).reverse();
    return {
      results: matches.slice(q.offset ?? 0, q.limit === undefined ? undefined : (q.offset ?? 0) + q.limit),
      totalMatches: matches.length,
      storedMessages: real.length,
      earliestStored: real[0]?.createdAt ?? null,
    };
  }

  async since(afterIso: string | null, cap: number): Promise<ReviewWindow> {
    const after = this.messages.filter((m) => !m.isSummary && (afterIso === null || m.createdAt > afterIso));
    return capWindow(after, cap);
  }

  async needsSummary(): Promise<boolean> {
    const live = this.messages.filter((m) => !m.isSummary && !m.rolledUp).length;
    return live > this.summaryThreshold;
  }

  async applySummary(summaryText: string, count: number): Promise<StoredMessage[]> {
    const toRoll = (await this.context()).slice(0, count);
    for (const m of toRoll) m.rolledUp = true;
    this.messages.push({
      id: newId("sum"),
      role: "assistant",
      content: summaryText,
      channel: "text",
      createdAt: this.clock.nowIso(),
      isSummary: true,
    });
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
  if (bool(row.rolled_up, "messages.rolled_up")) m.rolledUp = true;
  if (bool(row.forwarded, "messages.forwarded")) m.forwarded = true;
  const ref = optStr(row.source_ref, "messages.source_ref");
  if (ref) m.sourceRef = ref;
  return m;
}

function likePattern(query: string): string {
  return `%${query.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

/** D1-backed conversation store. Same interface, same semantics. */
export class D1ConversationRepo implements ConversationStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
    private readonly summaryThreshold = 40,
  ) {}

  async append(role: "user" | "assistant", content: string, channel: Channel, meta: AppendMeta = {}): Promise<StoredMessage> {
    const m: StoredMessage = {
      id: newId("msg"),
      role,
      content,
      channel,
      createdAt: this.clock.nowIso(),
    };
    if (meta.forwarded) m.forwarded = true;
    if (meta.sourceRef) m.sourceRef = meta.sourceRef;
    await this.db
      .prepare(
        `INSERT INTO messages (id, role, content, channel, created_at, is_summary, rolled_up, forwarded, source_ref)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .bind(m.id, m.role, m.content, m.channel, m.createdAt, m.forwarded ? 1 : 0, m.sourceRef ?? null)
      .run();
    return m;
  }

  async get(id: string): Promise<StoredMessage | undefined> {
    const row = await this.db.prepare(`SELECT * FROM messages WHERE id = ?`).bind(id).first<D1Row>();
    return row ? rowToMessage(row) : undefined;
  }

  async all(): Promise<StoredMessage[]> {
    const res = await this.db.prepare(`SELECT * FROM messages ORDER BY rowid ASC`).all<D1Row>();
    return res.results.map(rowToMessage);
  }

  async context(): Promise<StoredMessage[]> {
    const res = await this.db
      .prepare(`SELECT * FROM messages WHERE rolled_up = 0 ORDER BY is_summary DESC, rowid ASC`)
      .all<D1Row>();
    return res.results.map(rowToMessage);
  }

  async recent(limit = 30): Promise<StoredMessage[]> {
    return (await this.context()).slice(-limit);
  }

  async search(q: HistoryQuery): Promise<HistoryResult> {
    const where = [`is_summary = 0`, `lower(content) LIKE ? ESCAPE '\\'`];
    const params: unknown[] = [likePattern(q.query)];
    if (q.channel) {
      where.push(`channel = ?`);
      params.push(q.channel);
    }
    if (q.since) {
      where.push(`created_at >= ?`);
      params.push(new Date(q.since).toISOString());
    }
    if (q.until) {
      where.push(`created_at <= ?`);
      params.push(new Date(q.until).toISOString());
    }
    const clause = where.join(" AND ");
    const total = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${clause}`)
      .bind(...params)
      .first<D1Row>();
    const rows = await this.db
      // LIMIT -1 = no limit in SQLite: omitting `limit` returns every match.
      .prepare(`SELECT * FROM messages WHERE ${clause} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .bind(...params, q.limit ?? -1, q.offset ?? 0)
      .all<D1Row>();
    const coverage = await this.db
      .prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS earliest FROM messages WHERE is_summary = 0`)
      .first<D1Row>();
    return {
      results: rows.results.map(rowToMessage),
      totalMatches: num(total?.n, "count"),
      storedMessages: num(coverage?.n, "count"),
      earliestStored: optStr(coverage?.earliest, "earliest"),
    };
  }

  async since(afterIso: string | null, cap: number): Promise<ReviewWindow> {
    // Fetch one past the cap so a split timestamp can be detected; count the rest.
    const cond = afterIso === null ? `is_summary = 0` : `is_summary = 0 AND created_at > ?`;
    const params = afterIso === null ? [] : [afterIso];
    const rows = await this.db
      .prepare(`SELECT * FROM messages WHERE ${cond} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .bind(...params, cap + 1)
      .all<D1Row>();
    const total = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${cond}`)
      .bind(...params)
      .first<D1Row>();
    let fetched = rows.results.map(rowToMessage);
    if (fetched.length > cap && fetched.every((m) => m.createdAt === fetched[0]!.createdAt)) {
      // Rare: more than `cap` messages share one instant. capWindow needs all of them.
      const instant = fetched[0]!.createdAt;
      const same = await this.db
        .prepare(`SELECT * FROM messages WHERE ${cond} AND created_at <= ? ORDER BY created_at ASC, rowid ASC`)
        .bind(...params, instant)
        .all<D1Row>();
      fetched = same.results.map(rowToMessage);
    }
    const win = capWindow(fetched, cap);
    return { messages: win.messages, deferred: num(total?.n, "count") - win.messages.length };
  }

  async needsSummary(): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE is_summary = 0 AND rolled_up = 0`)
      .first<D1Row>();
    return num(row?.n, "count") > this.summaryThreshold;
  }

  async applySummary(summaryText: string, count: number): Promise<StoredMessage[]> {
    const toRoll = (await this.context()).slice(0, count);
    for (const m of toRoll) {
      await this.db.prepare(`UPDATE messages SET rolled_up = 1 WHERE id = ?`).bind(m.id).run();
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
        `INSERT INTO messages (id, role, content, channel, created_at, is_summary, rolled_up, forwarded, source_ref)
         VALUES (?, ?, ?, ?, ?, 1, 0, 0, NULL)`,
      )
      .bind(summary.id, summary.role, summary.content, summary.channel, summary.createdAt)
      .run();
    return toRoll;
  }
}
