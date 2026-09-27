import { describe, expect, it } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { fakeToolCall } from "../src/model/fake-model.js";
import { memorySave, memorySearch } from "../src/memory/memory-tools.js";

describe("Phase 2: memory", () => {
  it("saves a stated fact only when the quote really appears in Sid's message", async () => {
    const h = makeHarness([
      {
        content: "",
        toolCalls: [
          fakeToolCall("memory_save", {
            text: "Sid hates mornings",
            kind: "durable",
            confidence: "stated",
            quote: "i hate mornings",
          }),
        ],
      },
      { content: "Noted." },
    ]);
    await h.agent.handle(ownerEvent("honestly i hate mornings so much"));
    const facts = await h.facts.activeFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]!.text).toBe("Sid hates mornings");
    expect(facts[0]!.confidence).toBe("stated");
  });

  it("refuses a stated fact whose quote is NOT in Sid's message (provenance check)", async () => {
    const h = makeHarness([
      {
        content: "",
        toolCalls: [
          fakeToolCall("memory_save", {
            text: "Sid loves mornings",
            kind: "durable",
            confidence: "stated",
            quote: "i love mornings",
          }),
        ],
      },
      { content: "ok" },
    ]);
    await h.agent.handle(ownerEvent("i hate mornings"));
    expect(await h.facts.all()).toHaveLength(0);
    const rejected = (await h.receipts.all()).find((r) => r.tool === "memory_save" && r.status === "refused");
    expect(rejected).toBeTruthy();
    expect(rejected!.resultJson).toContain("Provenance check failed");
  });

  it("refuses a temporary fact with no expires_at, never defaulting it", async () => {
    const h = makeHarness([{ content: "ok" }]);
    const ctx = h.ctxFor(ownerEvent("away this weekend"));
    const res = await memorySave.run(
      { text: "Sid is away", kind: "temporary", confidence: "inferred" },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe("refused");
    expect(res.message).toContain("expires_at");
  });

  it("meaning search returns a related fact and never returns hidden or expired ones", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx = h.ctxFor(ownerEvent("seed"));
    await memorySave.run(
      { text: "Sid hates mornings", kind: "durable", confidence: "inferred" },
      ctx,
    );
    await memorySave.run(
      { text: "Sid enjoys late nights coding", kind: "durable", confidence: "inferred" },
      ctx,
    );

    const found = await memorySearch.run({ query: "mornings", limit: 5 }, ctx);
    const results = (found.data as any).results as any[];
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("mornings");

    // Hide the morning fact; it must vanish from search.
    const morningId = results[0].id;
    await h.facts.forget(morningId);
    await h.vectors.remove(morningId);
    const after = await memorySearch.run({ query: "mornings", limit: 5 }, ctx);
    const afterResults = (after.data as any).results as any[];
    expect(afterResults.find((r) => r.id === morningId)).toBeUndefined();
  });

  it("temporary facts drop out of recall after expires_at", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx = h.ctxFor(ownerEvent("seed"));
    const expiry = new Date(h.clock.nowMs() + 1000).toISOString();
    await memorySave.run(
      { text: "Sid is away this weekend", kind: "temporary", confidence: "inferred", expires_at: expiry },
      ctx,
    );
    expect(await h.facts.activeFacts()).toHaveLength(1);
    h.clock.advance(2000);
    expect(await h.facts.activeFacts()).toHaveLength(0);
    const after = await memorySearch.run({ query: "away weekend", limit: 5 }, ctx);
    expect(((after.data as any).results as any[])).toHaveLength(0);
  });

  it("corrections create a new version linked to the old (never overwrite)", async () => {
    const h = makeHarness([]);
    const f1 = await h.facts.save({
      text: "Sid has an iPhone 15",
      kind: "durable",
      confidence: "stated",
      sourceType: "conversation",
      sourceRef: "x",
      expiresAt: null,
    });
    const f2 = await h.facts.correct(f1.id, {
      text: "Sid has an iPhone 16", confidence: "stated", kind: "durable", expiresAt: null,
      reason: "upgraded", sourceType: "conversation", sourceRef: "y", sourceMessageId: null,
    });
    expect((await h.facts.get(f1.id))!.supersededBy).toBe(f2.id);
    const chain = await h.facts.explain(f2.id);
    expect(chain.map((f) => f.text)).toEqual(["Sid has an iPhone 15", "Sid has an iPhone 16"]);
    // Superseded facts are not active.
    expect((await h.facts.activeFacts()).map((f) => f.text)).toEqual(["Sid has an iPhone 16"]);
  });

  it("pinned facts (core profile) are injected into the system prompt every turn", async () => {
    const h = makeHarness([{ content: "hi" }]);
    const f = await h.facts.save({
      text: "Sid is a student in Ontario",
      kind: "durable",
      confidence: "confirmed",
      sourceType: "conversation",
      sourceRef: "x",
      expiresAt: null,
      pinned: true,
    });
    expect(f.pinned).toBe(true);
    await h.agent.handle(ownerEvent("hello"));
    const system = h.model.requests[0]!.messages[0]!.content;
    expect(system).toContain("Sid is a student in Ontario");
  });

  it("the SAME memory serves text and voice (one store, no bridge needed)", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx = h.ctxFor(ownerEvent("seed"));
    await memorySave.run({ text: "Sid hates mornings", kind: "durable", confidence: "inferred" }, ctx);
    // A voice-channel context queries the same repos.
    const voiceCtx = h.ctxFor(ownerEvent("what do you know", "call1", { channel: "voice", trigger: "call" }));
    const found = await memorySearch.run({ query: "mornings", limit: 5 }, voiceCtx);
    expect(((found.data as any).results as any[]).length).toBeGreaterThan(0);
  });
});
