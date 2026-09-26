import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
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
 */
export class FactsRepo {
  private readonly facts = new Map<string, Fact>();
  constructor(private readonly clock: Clock) {}

  save(input: SaveFactInput): Fact {
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

  get(id: string): Fact | undefined {
    return this.facts.get(id);
  }

  /** memory_correct: new version linked to the old; old is superseded, never erased. */
  correct(
    factId: string,
    newText: string,
    confidence: FactConfidence,
    kind: FactKind,
    expiresAt: string | null,
  ): Fact {
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

  forget(id: string): Fact {
    const f = this.mustGet(id);
    f.hidden = true;
    return f;
  }
  restore(id: string): Fact {
    const f = this.mustGet(id);
    f.hidden = false;
    return f;
  }
  confirm(id: string): Fact {
    const f = this.mustGet(id);
    f.confidence = "confirmed";
    return f;
  }
  pin(id: string): Fact {
    const f = this.mustGet(id);
    f.pinned = true;
    return f;
  }
  unpin(id: string): Fact {
    const f = this.mustGet(id);
    f.pinned = false;
    return f;
  }

  /** The version chain for memory_explain: oldest -> newest. */
  explain(id: string): Fact[] {
    // Walk backwards to the root, then forwards along supersededBy.
    const start = this.mustGet(id);
    // find root: any fact whose supersededBy points to start, transitively
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

  /** Active = not hidden, not expired, not superseded. */
  activeFacts(): Fact[] {
    const now = this.clock.nowMs();
    return [...this.facts.values()].filter((f) => this.isActive(f, now));
  }

  pinnedFacts(): Fact[] {
    return this.activeFacts().filter((f) => f.pinned);
  }

  isActive(f: Fact, now = this.clock.nowMs()): boolean {
    if (f.hidden) return false;
    if (f.supersededBy) return false;
    if (f.expiresAt && new Date(f.expiresAt).getTime() <= now) return false;
    return true;
  }

  all(): Fact[] {
    return [...this.facts.values()];
  }

  private mustGet(id: string): Fact {
    const f = this.facts.get(id);
    if (!f) throw new Error(`fact ${id} does not exist`);
    return f;
  }
}
