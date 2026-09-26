import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { bool, optStr, str } from "../persistence/d1.js";
import type { Fact, FactConfidence, FactKind } from "../types.js";

export interface SaveFactInput {
  text: string;
  kind: FactKind;
  confidence: FactConfidence;
  sourceType: Fact["sourceType"];
  sourceRef: string;
  /** Required. For temporary facts the model MUST supply a real instant. */
  expiresAt: string | null;
  pinned?: boolean;
}

/**
 * The facts ledger. Corrections never overwrite: memory_correct creates a new
 * version linked to the old one. forget only hides (reversible).
 * Async: D1 is async-only, so both stores share one async interface.
 */
export interface FactsStore {
  save(input: SaveFactInput): Promise<Fact>;
  get(id: string): Promise<Fact | undefined>;
  correct(
    factId: string,
    newText: string,
    confidence: FactConfidence,
    kind: FactKind,
    expiresAt: string | null,
  ): Promise<Fact>;
  forget(id: string): Promise<Fact>;
  restore(id: string): Promise<Fact>;
  confirm(id: string): Promise<Fact>;
  pin(id: string): Promise<Fact>;
  unpin(id: string): Promise<Fact>;
  /** The version chain for memory_explain: oldest -> newest. */
  explain(id: string): Promise<Fact[]>;
  activeFacts(): Promise<Fact[]>;
  pinnedFacts(): Promise<Fact[]>;
  /** Pure check on a fact object (no storage read), so it stays sync. */
  isActive(f: Fact, now?: number): boolean;
  all(): Promise<Fact[]>;
}

/** Active = not hidden, not expired, not superseded. Shared by both stores. */
export function factIsActive(f: Fact, now: number): boolean {
  if (f.hidden) return false;
  if (f.supersededBy) return false;
  if (f.expiresAt && new Date(f.expiresAt).getTime() <= now) return false;
  return true;
}

export class FactsRepo implements FactsStore {
  private readonly facts = new Map<string, Fact>();
  constructor(private readonly clock: Clock) {}

  async save(input: SaveFactInput): Promise<Fact> {
    const fact: Fact = {
      id: newId("fact"),
      text: input.text,
      kind: input.kind,
      confidence: input.confidence,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      createdAt: this.clock.nowIso(),
      expiresAt: input.expiresAt,
      supersededBy: null,
      hidden: false,
      pinned: input.pinned ?? false,
    };
    this.facts.set(fact.id, fact);
    return fact;
  }

  async get(id: string): Promise<Fact | undefined> {
    return this.facts.get(id);
  }

  /** memory_correct: new version linked to the old; old is superseded, never erased. */
  async correct(
    factId: string,
    newText: string,
    confidence: FactConfidence,
    kind: FactKind,
    expiresAt: string | null,
  ): Promise<Fact> {
    const old = this.facts.get(factId);
    if (!old) throw new Error(`fact ${factId} does not exist`);
    const next: Fact = {
      id: newId("fact"),
      text: newText,
      kind,
      confidence,
      sourceType: old.sourceType,
      sourceRef: old.sourceRef,
      createdAt: this.clock.nowIso(),
      expiresAt,
      supersededBy: null,
      hidden: false,
      pinned: old.pinned,
    };
    this.facts.set(next.id, next);
    old.supersededBy = next.id;
    return next;
  }

  async forget(id: string): Promise<Fact> {
    const f = this.mustGet(id);
    f.hidden = true;
    return f;
  }
  async restore(id: string): Promise<Fact> {
    const f = this.mustGet(id);
    f.hidden = false;
    return f;
  }
  async confirm(id: string): Promise<Fact> {
    const f = this.mustGet(id);
    f.confidence = "confirmed";
    return f;
  }
  async pin(id: string): Promise<Fact> {
    const f = this.mustGet(id);
    f.pinned = true;
    return f;
  }
  async unpin(id: string): Promise<Fact> {
    const f = this.mustGet(id);
    f.pinned = false;
    return f;
  }

  async explain(id: string): Promise<Fact[]> {
    const start = this.mustGet(id);
    const bySuperseded = new Map<string, Fact>();
    for (const f of this.facts.values()) {
      if (f.supersededBy) bySuperseded.set(f.supersededBy, f);
    }
    let root = start;
    while (bySuperseded.has(root.id)) {
      root = bySuperseded.get(root.id)!;
    }
    const chain: Fact[] = [];
    let cur: Fact | undefined = root;
    while (cur) {
      chain.push(cur);
      cur = cur.supersededBy ? this.facts.get(cur.supersededBy) : undefined;
    }
    return chain;
  }

  async activeFacts(): Promise<Fact[]> {
    const now = this.clock.nowMs();
    return [...this.facts.values()].filter((f) => factIsActive(f, now));
  }

  async pinnedFacts(): Promise<Fact[]> {
    return (await this.activeFacts()).filter((f) => f.pinned);
  }

  isActive(f: Fact, now = this.clock.nowMs()): boolean {
    return factIsActive(f, now);
  }

  async all(): Promise<Fact[]> {
    return [...this.facts.values()];
  }

  private mustGet(id: string): Fact {
    const f = this.facts.get(id);
    if (!f) throw new Error(`fact ${id} does not exist`);
    return f;
  }
}

function rowToFact(row: D1Row): Fact {
  return {
    id: str(row.id, "facts.id"),
    text: str(row.text, "facts.text"),
    kind: str(row.kind, "facts.kind") as FactKind,
    confidence: str(row.confidence, "facts.confidence") as FactConfidence,
    sourceType: str(row.source_type, "facts.source_type") as Fact["sourceType"],
    sourceRef: str(row.source_ref, "facts.source_ref"),
    createdAt: str(row.created_at, "facts.created_at"),
    expiresAt: optStr(row.expires_at, "facts.expires_at"),
    supersededBy: optStr(row.superseded_by, "facts.superseded_by"),
    hidden: bool(row.hidden, "facts.hidden"),
    pinned: bool(row.pinned, "facts.pinned"),
  };
}

/** D1-backed facts ledger. Same interface, same semantics, real persistence. */
export class D1FactsRepo implements FactsStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
  ) {}

  async save(input: SaveFactInput): Promise<Fact> {
    const fact: Fact = {
      id: newId("fact"),
      text: input.text,
      kind: input.kind,
      confidence: input.confidence,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      createdAt: this.clock.nowIso(),
      expiresAt: input.expiresAt,
      supersededBy: null,
      hidden: false,
      pinned: input.pinned ?? false,
    };
    await this.db
      .prepare(
        `INSERT INTO facts (id, text, kind, confidence, source_type, source_ref,
         created_at, expires_at, superseded_by, hidden, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        fact.id, fact.text, fact.kind, fact.confidence, fact.sourceType, fact.sourceRef,
        fact.createdAt, fact.expiresAt, fact.supersededBy, fact.hidden ? 1 : 0,
        fact.pinned ? 1 : 0,
      )
      .run();
    return fact;
  }

  async get(id: string): Promise<Fact | undefined> {
    const row = await this.db.prepare(`SELECT * FROM facts WHERE id = ?`).bind(id).first<D1Row>();
    return row ? rowToFact(row) : undefined;
  }

  async correct(
    factId: string,
    newText: string,
    confidence: FactConfidence,
    kind: FactKind,
    expiresAt: string | null,
  ): Promise<Fact> {
    const old = await this.get(factId);
    if (!old) throw new Error(`fact ${factId} does not exist`);
    const next: Fact = {
      id: newId("fact"),
      text: newText,
      kind,
      confidence,
      sourceType: old.sourceType,
      sourceRef: old.sourceRef,
      createdAt: this.clock.nowIso(),
      expiresAt,
      supersededBy: null,
      hidden: false,
      pinned: old.pinned,
    };
    await this.db
      .prepare(
        `INSERT INTO facts (id, text, kind, confidence, source_type, source_ref,
         created_at, expires_at, superseded_by, hidden, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        next.id, next.text, next.kind, next.confidence, next.sourceType, next.sourceRef,
        next.createdAt, next.expiresAt, next.supersededBy, 0, next.pinned ? 1 : 0,
      )
      .run();
    await this.db
      .prepare(`UPDATE facts SET superseded_by = ? WHERE id = ?`)
      .bind(next.id, factId)
      .run();
    return next;
  }

  private async setFlag(id: string, column: "hidden" | "pinned", value: boolean): Promise<Fact> {
    await this.db.prepare(`UPDATE facts SET ${column} = ? WHERE id = ?`).bind(value ? 1 : 0, id).run();
    return this.mustGet(id);
  }

  async forget(id: string): Promise<Fact> {
    return this.setFlag(id, "hidden", true);
  }
  async restore(id: string): Promise<Fact> {
    return this.setFlag(id, "hidden", false);
  }
  async pin(id: string): Promise<Fact> {
    return this.setFlag(id, "pinned", true);
  }
  async unpin(id: string): Promise<Fact> {
    return this.setFlag(id, "pinned", false);
  }

  async confirm(id: string): Promise<Fact> {
    await this.db.prepare(`UPDATE facts SET confidence = 'confirmed' WHERE id = ?`).bind(id).run();
    return this.mustGet(id);
  }

  async explain(id: string): Promise<Fact[]> {
    const start = await this.mustGet(id);
    // Walk backwards to the root via superseded_by predecessors, then forwards.
    let root = start;
    for (;;) {
      const prev = await this.db
        .prepare(`SELECT * FROM facts WHERE superseded_by = ?`)
        .bind(root.id)
        .first<D1Row>();
      if (!prev) break;
      root = rowToFact(prev);
    }
    const chain: Fact[] = [];
    let cur: Fact | undefined = root;
    while (cur) {
      chain.push(cur);
      cur = cur.supersededBy ? await this.get(cur.supersededBy) : undefined;
    }
    return chain;
  }

  async activeFacts(): Promise<Fact[]> {
    // ISO instants compare lexicographically = chronologically.
    const res = await this.db
      .prepare(
        `SELECT * FROM facts WHERE hidden = 0 AND superseded_by IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .bind(this.clock.nowIso())
      .all<D1Row>();
    return res.results.map(rowToFact);
  }

  async pinnedFacts(): Promise<Fact[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM facts WHERE hidden = 0 AND superseded_by IS NULL AND pinned = 1
         AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .bind(this.clock.nowIso())
      .all<D1Row>();
    return res.results.map(rowToFact);
  }

  isActive(f: Fact, now = this.clock.nowMs()): boolean {
    return factIsActive(f, now);
  }

  async all(): Promise<Fact[]> {
    const res = await this.db.prepare(`SELECT * FROM facts`).all<D1Row>();
    return res.results.map(rowToFact);
  }

  private async mustGet(id: string): Promise<Fact> {
    const f = await this.get(id);
    if (!f) throw new Error(`fact ${id} does not exist`);
    return f;
  }
}
