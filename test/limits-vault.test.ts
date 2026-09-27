import { describe, expect, it } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { freshDb } from "./d1-testkit.js";
import { FixedClock } from "../src/clock.js";
import { D1ConversationRepo, ConversationRepo } from "../src/conversation/conversation-repo.js";
import { historySearch, memoryList, memorySearch } from "../src/memory/memory-tools.js";
import { archiveSearch } from "../src/plumbing/archive.js";
import { buildVaultExport } from "../src/plumbing/vault.js";
import type { VectorHit, VectorIndex } from "../src/memory/embeddings.js";

/**
 * Sid (2026-09-26): "Jarvis should get as much as he needs to do what he wants."
 * No hidden count caps: `limit` is optional (omitted = everything), `offset`
 * pages, and every answer says how many there are in total.
 */

async function seed(h: ReturnType<typeof makeHarness>, n: number, text = (i: number) => `fact number ${i} about coffee`) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = await h.facts.save({
      text: text(i), kind: "durable", confidence: "stated", sourceType: "conversation",
      sourceRef: `s${i}`, expiresAt: null, pinned: false,
    });
    await h.vectors.upsert(f.id, await h.embeddings.embed(f.text));
    ids.push(f.id);
  }
  return ids;
}

describe("history_search: no hidden cap", () => {
  for (const kind of ["in-memory", "D1"] as const) {
    it(`omitting limit returns every match; offset pages (${kind})`, async () => {
      const clock = new FixedClock();
      const convo = kind === "D1" ? new D1ConversationRepo(freshDb(), clock, 100_000) : new ConversationRepo(clock, 100_000);
      for (let i = 0; i < 260; i++) await convo.append("user", `gym note ${i}`, "text");
      const h = makeHarness([], { clock, stores: { conversation: convo } });
      const ctx = h.ctxFor(ownerEvent("x"));
      const all = (await historySearch.run({ query: "gym" }, ctx)).data as any;
      expect(all.results).toHaveLength(260); // the old cap was 200
      expect(all.totalMatches).toBe(260);
      expect(all.nextOffset).toBeNull();
      const page = (await historySearch.run({ query: "gym", limit: 100, offset: 200 }, ctx)).data as any;
      expect(page.results).toHaveLength(60);
      expect(page.results[0].content).toBe("gym note 59"); // newest first, skipped 200
      expect(page.nextOffset).toBeNull();
      const first = (await historySearch.run({ query: "gym", limit: 10 }, ctx)).data as any;
      expect(first.nextOffset).toBe(10);
    });
  }
});

describe("memory_search: no hidden cap, honest ceiling", () => {
  it("omitting limit returns every active match (the old cap was 50)", async () => {
    const h = makeHarness([]);
    await seed(h, 70);
    const r = (await memorySearch.run({ query: "coffee" }, h.ctxFor(ownerEvent("x")))).data as any;
    expect(r.results).toHaveLength(70);
    expect(r.totalMatches).toBe(70);
    expect(r.indexCeiling).toBeUndefined(); // the in-memory index has no ceiling
    const page = (await memorySearch.run({ query: "coffee", limit: 20, offset: 60 }, h.ctxFor(ownerEvent("x")))).data as any;
    expect(page.results).toHaveLength(10);
    expect(page.nextOffset).toBeNull();
  });

  it("reports the index's own ceiling when it bites (Vectorize ranks at most 100)", async () => {
    const h = makeHarness([]);
    const ids = await seed(h, 5);
    const capped: VectorIndex = {
      maxTopK: 3,
      upsert: async () => {},
      remove: async () => {},
      query: async (_v, k): Promise<VectorHit[]> => ids.slice(0, Math.min(k, 3)).map((id, i) => ({ id, score: 1 - i / 10 })),
    };
    const ctx = { ...h.ctxFor(ownerEvent("x")), vectors: capped };
    const r = (await memorySearch.run({ query: "coffee" }, ctx)).data as any;
    expect(r.results).toHaveLength(3);
    expect(r.indexCeiling).toBe(3); // and the description points at memory_list for everything
  });
});

describe("memory_list: read everything without a query", () => {
  it("lists every active fact; include_inactive adds forgotten/corrected ones, labelled", async () => {
    const h = makeHarness([]);
    const [a, b, c] = await seed(h, 3, (i) => `fact ${i}`);
    await h.facts.forget(a!);
    await h.facts.correct(b!, {
      text: "fact 1 fixed", kind: "durable", confidence: "stated", expiresAt: null,
      reason: "Sid corrected it", sourceType: "conversation", sourceRef: "s-fix", sourceMessageId: null,
    });
    const ctx = h.ctxFor(ownerEvent("x"));
    const active = (await memoryList.run({}, ctx)).data as any;
    expect(active.results.map((f: any) => f.id)).not.toContain(a);
    expect(active.results.map((f: any) => f.id)).toContain(c);
    const everything = (await memoryList.run({ include_inactive: true }, ctx)).data as any;
    const forgotten = everything.results.find((f: any) => f.id === a);
    expect(forgotten.status).toContain("hidden");
    const corrected = everything.results.find((f: any) => f.id === b);
    expect(corrected.status).toContain("superseded");
    expect(active.results.some((f: any) => f.text === "fact 1 fixed")).toBe(true);
    expect(everything.total).toBeGreaterThan(active.total);
    const paged = (await memoryList.run({ limit: 1 }, ctx)).data as any;
    expect(paged.results).toHaveLength(1);
    expect(paged.nextOffset).toBe(1);
    expect((await memoryList.run({ kind: "forever" }, ctx)).status).toBe("refused");
  });
});

describe("archive_search: no hidden cap", () => {
  it("returns every match (the old cap was 500) with total and paging", async () => {
    const h = makeHarness([]);
    for (let i = 0; i < 520; i++) {
      await h.archive.append({ id: `m${i}`, at: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(), role: "user", content: `pizza ${i}`, channel: "text" });
    }
    const ctx = h.ctxFor(ownerEvent("x"));
    const all = (await archiveSearch.run({ query: "pizza" }, ctx)).data as any;
    expect(all.results).toHaveLength(520);
    expect(all.total).toBe(520);
    const page = (await archiveSearch.run({ query: "pizza", limit: 50, offset: 500 }, ctx)).data as any;
    expect(page.results).toHaveLength(20);
    expect(page.results[0].content).toBe("pizza 500"); // oldest first
    expect((await archiveSearch.run({ query: "pizza", from: "yesterday" }, ctx)).status).toBe("refused");
  });
});

describe("vault export keeps forgotten and corrected facts, labelled", () => {
  it("every fact is exported with a status line", async () => {
    const h = makeHarness([]);
    const [a, b] = await seed(h, 2, (i) => `fact ${i}`);
    await h.facts.forget(a!);
    await h.facts.correct(b!, {
      text: "fact 1 fixed", kind: "durable", confidence: "stated", expiresAt: null,
      reason: "fix", sourceType: "conversation", sourceRef: "s-fix", sourceMessageId: null,
    });
    const exported = buildVaultExport(await h.facts.all(), [], { isActive: (f) => h.facts.isActive(f) });
    const noteA = exported.notes.find((n) => n.path.includes(a!))!;
    const noteB = exported.notes.find((n) => n.path.includes(b!))!;
    expect(noteA.markdown).toContain("status: forgotten");
    expect(noteB.markdown).toContain("status: corrected");
    expect(exported.notes.some((n) => n.markdown.includes("fact 1 fixed") && n.markdown.includes("status: active"))).toBe(true);
    expect(noteA.markdown).toContain("superseded_by:");
  });
});
