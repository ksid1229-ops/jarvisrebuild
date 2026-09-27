/**
 * Memory hardening. Each test names the exact behaviour it pins, and each key
 * guard here was mutation-checked (see PROGRESS.md, "Mutation checks").
 */
import { describe, expect, it, vi } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { freshDb } from "./d1-testkit.js";
import { fakeToolCall, FakeModel } from "../src/model/fake-model.js";
import { FixedClock } from "../src/clock.js";
import { ConversationRepo, D1ConversationRepo } from "../src/conversation/conversation-repo.js";
import { D1FactsRepo } from "../src/memory/facts-repo.js";
import { historySearch, memoryCorrect, memoryExplain, memorySave, memorySearch } from "../src/memory/memory-tools.js";
import {
  CloudflareVectorizeIndex,
  FakeEmbeddingProvider,
  UnavailableEmbeddingProvider,
  type EmbeddingProvider,
  type VectorizeLike,
} from "../src/memory/embeddings.js";
import { D1MemoryRunsRepo, MEMORY_REVIEW_QUIET_MS, REVIEW_MESSAGE_CAP } from "../src/memory/memory-review.js";
import { InMemoryBucket, R2BucketAdapter, type Bucket, type R2Like } from "../src/plumbing/bucket.js";
import { BackupService } from "../src/plumbing/backup.js";
import { archiveSearch } from "../src/plumbing/archive.js";
import { fireWakeup, handleCron, HOURLY_CRON } from "../src/scheduler/cron.js";
import { RETRY_FLOOR_MS, WakeupScheduler } from "../src/scheduler/wakeup-scheduler.js";
import { WakeupsRepo } from "../src/scheduler/wakeups-repo.js";
import { WatchdogPinger } from "../src/plumbing/watchdog.js";
import type { ModelRequest } from "../src/model/types.js";

const T0 = "2026-09-26T12:00:00.000Z";

/** Pull the review instruction (last user message) out of a model request. */
function lastUser(req: ModelRequest): string {
  return [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

describe("conversation is never deleted", () => {
  it("a summary replaces old messages in CONTEXT only; the record and history_search keep every word", async () => {
    const clock = new FixedClock(T0);
    const convo = new ConversationRepo(clock, 2);
    await convo.append("user", "my locker code is 4821", "text");
    await convo.append("assistant", "noted", "text");
    await convo.append("user", "ok bye", "voice");
    await convo.applySummary("Sid shared his locker code.", 2);

    expect((await convo.context()).map((m) => m.content)).toEqual(["Sid shared his locker code.", "ok bye"]);
    const found = await convo.search({ query: "4821", limit: 10 });
    expect(found.results.map((m) => m.content)).toEqual(["my locker code is 4821"]);
    // Summaries are the model's words, not the record: never returned by literal search.
    expect((await convo.search({ query: "locker", limit: 10 })).results.every((m) => !m.isSummary)).toBe(true);
    expect(found.storedMessages).toBe(3);
  });

  /** A model that replies to live turns and answers summary requests with `summary`. */
  function summarizingModel(summary: string): (req: ModelRequest) => { content: string; toolCalls: [] } {
    return (req) => ({
      content: req.messages[0]!.content.startsWith("Summarize") ? summary : "ok",
      toolCalls: [],
    });
  }

  it("the agent's size-triggered summary keeps rolled-up messages searchable (end to end)", async () => {
    const clock = new FixedClock(T0);
    const conversation = new ConversationRepo(clock, 16);
    const h = makeHarness(Array.from({ length: 40 }, () => summarizingModel("SUMMARY: early chat")), { clock, stores: { conversation } });
    await h.agent.handle(ownerEvent("first thing: dentist on Tuesday", "a"));
    for (let i = 0; i < 8; i++) await h.agent.handle(ownerEvent(`filler ${i}`, `f${i}`));
    // 18 live messages > 16 => the model wrote a summary that replaced the oldest in context.
    const ctxContents = (await conversation.context()).map((m) => m.content);
    expect(ctxContents[0]).toBe("SUMMARY: early chat");
    expect(ctxContents).not.toContain("first thing: dentist on Tuesday");
    const res = await historySearch.run({ query: "dentist", limit: 5 }, h.ctxFor(ownerEvent("x")));
    expect((res.data as any).results.map((r: any) => r.content)).toEqual(["first thing: dentist on Tuesday"]);
  });

  it("an empty model summary is surfaced as a receipt, not silently skipped", async () => {
    const clock = new FixedClock(T0);
    const conversation = new ConversationRepo(clock, 16);
    const h = makeHarness(Array.from({ length: 40 }, () => summarizingModel("   ")), { clock, stores: { conversation } });
    for (let i = 0; i < 9; i++) await h.agent.handle(ownerEvent(`msg ${i}`, `m${i}`));
    const r = (await h.receipts.all()).find((x) => x.tool === "summarize");
    expect(r?.status).toBe("empty_reply");
    expect((await conversation.context()).some((m) => m.isSummary)).toBe(false);
  });
});

describe("stated facts rest on one real message of Sid's", () => {
  it("a live stated fact links to the stored message, and memory_explain quotes it", async () => {
    const h = makeHarness([
      { content: "", toolCalls: [fakeToolCall("memory_save", { text: "Sid hates mornings", kind: "durable", confidence: "stated", quote: "I hate mornings" })] },
      { content: "Noted." },
    ]);
    await h.agent.handle(ownerEvent("honestly I hate mornings"));
    const fact = (await h.facts.all())[0]!;
    const userMsg = (await h.conversation.all()).find((m) => m.role === "user")!;
    expect(fact.sourceMessageId).toBe(userMsg.id);
    const ex = await memoryExplain.run({ fact_id: fact.id }, h.ctxFor(ownerEvent("why")));
    const v = (ex.data as any).versions[0];
    expect(v.sourceMessage.content).toBe("honestly I hate mornings");
    expect(v.status).toBe("active");
  });

  it("a FORWARDED message cannot back a stated fact (its words are not Sid's)", async () => {
    const h = makeHarness([
      { content: "", toolCalls: [fakeToolCall("memory_save", { text: "x", kind: "durable", confidence: "stated", quote: "meeting at 5" })] },
      { content: "ok" },
    ]);
    await h.agent.handle(ownerEvent("meeting at 5", "f1", { provenance: { isForwarded: true } }));
    expect(await h.facts.all()).toHaveLength(0);
    const r = (await h.receipts.all()).find((x) => x.tool === "memory_save")!;
    expect(r.resultJson).toContain("forwarded");
  });

  it("a wake-up turn cannot claim 'stated' without citing a message", async () => {
    const h = makeHarness([]);
    const ctx = h.ctxFor(ownerEvent("hourly check", "w1", { trigger: "wakeup" }));
    const res = await memorySave.run({ text: "x", kind: "durable", confidence: "stated", quote: "hourly" }, ctx);
    expect(res.status).toBe("refused");
    expect(res.message).toContain("source_message_id");
  });

  it("citing source_message_id: must be Sid's, not forwarded, not Jarvis's, and contain the quote", async () => {
    const h = makeHarness([]);
    const sid = await h.conversation.append("user", "I switched to night shifts", "text");
    const fwd = await h.conversation.append("user", "I switched banks", "text", { forwarded: true });
    const mine = await h.conversation.append("assistant", "I switched your alarm", "text");
    const ctx = h.ctxFor(ownerEvent("memory review", "w2", { trigger: "wakeup" }));
    const base = { text: "t", kind: "durable", confidence: "stated" };

    const ok = await memorySave.run({ ...base, quote: "switched to night shifts", source_message_id: sid.id }, ctx);
    expect(ok.ok).toBe(true);
    expect((await h.facts.get((ok.data as any).id))!.sourceMessageId).toBe(sid.id);

    expect((await memorySave.run({ ...base, quote: "I switched banks", source_message_id: fwd.id }, ctx)).status).toBe("refused");
    expect((await memorySave.run({ ...base, quote: "switched your alarm", source_message_id: mine.id }, ctx)).status).toBe("refused"); // 3 words but not Sid's
    expect((await memorySave.run({ ...base, quote: "switched to day shifts", source_message_id: sid.id }, ctx)).status).toBe("refused"); // 4 words, but not in his message
    expect((await memorySave.run({ ...base, quote: "x", source_message_id: "msg_nope" }, ctx)).status).toBe("refused");
  });

  it("memory_correct: a stated correction needs a verified quote (the old hole is closed)", async () => {
    const h = makeHarness([]);
    const f = await h.facts.save({ text: "Sid has an iPhone 15", kind: "durable", confidence: "stated", sourceType: "conversation", sourceRef: "old", expiresAt: null });
    const m = await h.conversation.append("user", "I got the iPhone 16 today", "text");
    const ctx = h.ctxFor(ownerEvent("I got the iPhone 16 today", "e9"), m.id);
    const args = { fact_id: f.id, new_text: "Sid has an iPhone 16", confidence: "stated", kind: "durable", reason: "he upgraded" };

    expect((await memoryCorrect.run(args, ctx)).status).toBe("refused"); // no quote
    const ok = await memoryCorrect.run({ ...args, quote: "I got the iPhone 16" }, ctx);
    expect(ok.ok).toBe(true);
    const next = (await h.facts.get((ok.data as any).id))!;
    expect(next.correctionReason).toBe("he upgraded");
    // Its source is the correcting turn, not the old fact's.
    expect(next.sourceRef).toBe("telegram:sid:e9");
    expect(next.sourceMessageId).toBe(m.id);
    const ex = await memoryExplain.run({ fact_id: next.id }, ctx);
    expect((ex.data as any).versions.map((v: any) => v.status)).toEqual([`superseded by ${next.id}`, "active"]);
    expect((ex.data as any).versions[1].correctionReason).toBe("he upgraded");
  });

  it("memory_correct refuses an outdated version and names the current one (no forked chains)", async () => {
    const h = makeHarness([]);
    const f1 = await h.facts.save({ text: "a", kind: "durable", confidence: "inferred", sourceType: "conversation", sourceRef: "r", expiresAt: null });
    const ctx = h.ctxFor(ownerEvent("x"));
    const first = await memoryCorrect.run({ fact_id: f1.id, new_text: "b", confidence: "inferred", kind: "durable", reason: "r1" }, ctx);
    const res = await memoryCorrect.run({ fact_id: f1.id, new_text: "c", confidence: "inferred", kind: "durable", reason: "r2" }, ctx);
    expect(res.status).toBe("refused");
    expect((res.data as any).currentId).toBe((first.data as any).id);
    expect((await h.facts.activeFacts()).map((f) => f.text)).toEqual(["b"]);
  });

  it("D1: the guarded correction also refuses an outdated version against real SQLite", async () => {
    const clock = new FixedClock(T0);
    const facts = new D1FactsRepo(freshDb(), clock);
    const f1 = await facts.save({ text: "a", kind: "durable", confidence: "inferred", sourceType: "conversation", sourceRef: "r", expiresAt: null });
    const input = { text: "b", kind: "durable" as const, confidence: "inferred" as const, expiresAt: null, reason: "x", sourceType: "conversation" as const, sourceRef: "r", sourceMessageId: null };
    const f2 = await facts.correct(f1.id, input);
    await expect(facts.correct(f1.id, { ...input, text: "c" })).rejects.toThrow(f2.id);
    expect((await facts.all()).map((f) => f.text)).toEqual(["a", "b"]);
  });
});

describe("history_search", () => {
  it("filters by date range and channel, reports totals and coverage, and returns citable ids", async () => {
    const clock = new FixedClock("2026-09-20T12:00:00.000Z");
    const h = makeHarness([], { clock });
    await h.conversation.append("user", "gym at 6", "text");
    clock.set("2026-09-24T12:00:00.000Z");
    await h.conversation.append("user", "gym moved to 7", "voice");
    await h.conversation.append("assistant", "gym noted", "voice");
    const ctx = h.ctxFor(ownerEvent("x"));

    const all = (await historySearch.run({ query: "gym", limit: 10 }, ctx)).data as any;
    expect(all.totalMatches).toBe(3);
    expect(all.results[0].content).toBe("gym noted"); // newest first
    expect(all.results[0].id).toMatch(/^msg_/);
    expect(all.coverage).toEqual({ storedMessages: 3, earliestStored: "2026-09-20T12:00:00.000Z" });

    const voice = (await historySearch.run({ query: "gym", channel: "voice", limit: 10 }, ctx)).data as any;
    expect(voice.results.map((r: any) => r.content)).toEqual(["gym noted", "gym moved to 7"]);

    const early = (await historySearch.run({ query: "gym", until: "2026-09-21T00:00:00Z", limit: 10 }, ctx)).data as any;
    expect(early.results.map((r: any) => r.content)).toEqual(["gym at 6"]);

    const one = (await historySearch.run({ query: "gym", limit: 1 }, ctx)).data as any;
    expect(one.results).toHaveLength(1);
    expect(one.totalMatches).toBe(3); // the limit never hides the size of the answer
  });

  it("refuses a fake date, a bad channel and a bad limit/offset instead of guessing (a missing limit means everything)", async () => {
    const ctx = makeHarness([]).ctxFor(ownerEvent("x"));
    expect((await historySearch.run({ query: "a" }, ctx)).status).toBe("ok");
    expect((await historySearch.run({ query: "a", limit: 5, since: "last tuesday" }, ctx)).status).toBe("refused");
    expect((await historySearch.run({ query: "a", limit: 5, channel: "sms" }, ctx)).status).toBe("refused");
    expect((await historySearch.run({ query: "a", limit: 0 }, ctx)).status).toBe("refused");
    expect((await historySearch.run({ query: "a", offset: -1 }, ctx)).status).toBe("refused");
    expect((await memorySearch.run({ query: "a", limit: "lots" }, ctx)).status).toBe("refused");
  });

  it("D1: the same filters against real SQLite", async () => {
    const clock = new FixedClock("2026-09-20T12:00:00.000Z");
    const convo = new D1ConversationRepo(freshDb(), clock);
    await convo.append("user", "gym at 6", "text");
    clock.set("2026-09-24T12:00:00.000Z");
    await convo.append("user", "gym moved to 7", "voice", { forwarded: true, sourceRef: "tg:1" });
    const r = await convo.search({ query: "GYM", channel: "voice", since: "2026-09-23T00:00:00Z", limit: 10 });
    expect(r.results.map((m) => m.content)).toEqual(["gym moved to 7"]);
    expect(r.results[0]!.forwarded).toBe(true);
    expect(r.results[0]!.sourceRef).toBe("tg:1");
    expect(r.totalMatches).toBe(1);
    expect(r.earliestStored).toBe("2026-09-20T12:00:00.000Z");
  });
});

describe("memory reviews (auto-extraction wake-ups)", () => {
  it("nothing new => a nothing_new run and NO model call", async () => {
    const h = makeHarness([]);
    const run = await h.reviewer.run("hourly_cron");
    expect(run.status).toBe("nothing_new");
    expect(h.model.requests).toHaveLength(0);
  });

  it("hands the model the unreviewed messages with ids; a cited stated save succeeds; the cursor advances", async () => {
    const h = makeHarness([]);
    const m = await h.conversation.append("user", "btw I'm allergic to peanuts", "voice");
    h.model["turns"].push(
      (req: ModelRequest) => {
        expect(lastUser(req)).toContain(`[${m.id}]`);
        expect(lastUser(req)).toContain("(call) Sid: btw I'm allergic to peanuts");
        return {
          content: "",
          toolCalls: [fakeToolCall("memory_save", { text: "Sid is allergic to peanuts", kind: "durable", confidence: "stated", quote: "allergic to peanuts", source_message_id: m.id })],
        };
      },
      { content: "" },
    );
    const run = await h.reviewer.run("hourly_cron");
    expect(run.status).toBe("ok");
    expect(run.factsSaved).toBe(1);
    expect(run.messagesReviewed).toBe(1);
    expect((await h.facts.all())[0]!.sourceMessageId).toBe(m.id);
    // Same window is not reviewed twice.
    expect((await h.reviewer.run("hourly_cron")).status).toBe("nothing_new");
  });

  it("a model error records an error run and does NOT advance the cursor (same window next time)", async () => {
    const h = makeHarness([]);
    await h.conversation.append("user", "remember my sister is Priya", "text");
    h.model["turns"].push(() => {
      throw new Error("deepseek 503");
    });
    const bad = await h.reviewer.run("quiet_alarm");
    expect(bad.status).toBe("error");
    expect(bad.error).toContain("503");
    h.model["turns"].push({ content: "" });
    const retry = await h.reviewer.run("hourly_cron");
    expect(retry.status).toBe("ok");
    expect(retry.messagesReviewed).toBe(1);
  });

  it("MEMORY_EXTRACTION_MODEL: reviews run on the extraction model, live turns on the main one", async () => {
    const extraction = new FakeModel([{ content: "" }], "strong-extractor");
    const h = makeHarness([], { extractionModel: extraction });
    await h.conversation.append("user", "hi", "text");
    const run = await h.reviewer.run("hourly_cron");
    expect(run.model).toBe("strong-extractor");
    expect(extraction.requests).toHaveLength(1);
    expect(h.model.requests).toHaveLength(0);
  });

  it(`caps a review at ${REVIEW_MESSAGE_CAP} messages, reports the rest, and reviews them next run`, async () => {
    const clock = new FixedClock(T0);
    const h = makeHarness([{ content: "" }, { content: "" }], { clock });
    for (let i = 0; i < REVIEW_MESSAGE_CAP + 5; i++) {
      clock.advance(1000);
      await h.conversation.append("user", `m${i}`, "text");
    }
    const first = await h.reviewer.run("hourly_cron");
    expect(first.messagesReviewed).toBe(REVIEW_MESSAGE_CAP);
    expect(first.messagesDeferred).toBe(5);
    expect(lastUser(h.model.requests[0]!)).toContain("5 newer message(s) did not fit");
    const second = await h.reviewer.run("hourly_cron");
    expect(second.messagesReviewed).toBe(5);
    expect(second.messagesDeferred).toBe(0);
  });

  it("a live exchange arms ONE quiet-review timer 20 min out; the next exchange pushes it later", async () => {
    const clock = new FixedClock(T0);
    const h = makeHarness([{ content: "a" }, { content: "b" }], { clock });
    await h.agent.handle(ownerEvent("one", "1"));
    let timers = (await h.wakeups.list()).filter((w) => w.kind === "memory_review");
    expect(timers.map((w) => w.fireAt)).toEqual([new Date(Date.parse(T0) + MEMORY_REVIEW_QUIET_MS).toISOString()]);
    clock.advance(5 * 60 * 1000);
    await h.agent.handle(ownerEvent("two", "2"));
    timers = (await h.wakeups.list()).filter((w) => w.kind === "memory_review");
    expect(timers).toHaveLength(1);
    expect(timers[0]!.fireAt).toBe(new Date(Date.parse(T0) + 5 * 60 * 1000 + MEMORY_REVIEW_QUIET_MS).toISOString());
  });

  it("when the quiet timer fires (DO alarm path), a quiet_alarm review runs over that conversation", async () => {
    const clock = new FixedClock(T0);
    const h = makeHarness([{ content: "sure" }, { content: "" }], { clock });
    await h.agent.handle(ownerEvent("I start my new job Monday", "1"));
    clock.advance(MEMORY_REVIEW_QUIET_MS);
    const res = await h.wakeups.fireDue((w) => fireWakeup(w, { agent: h.agent, reviewer: h.reviewer }));
    expect(res.fired).toBe(1);
    const runs = await h.memoryRuns.all();
    expect(runs.map((r) => [r.trigger, r.status, r.messagesReviewed])).toEqual([["quiet_alarm", "ok", 2]]);
    expect(lastUser(h.model.requests[1]!)).toContain("the conversation went quiet");
  });

  it("the hourly cron runs the memory review and the re-index, and reports both", async () => {
    const h = makeHarness([{ content: "" }, { content: "" }]);
    await h.conversation.append("user", "x", "text");
    const res = await handleCron({
      cronExpr: HOURLY_CRON,
      agent: h.agent,
      scheduler: h.wakeups,
      heartbeat: h.heartbeat,
      watchdog: new WatchdogPinger(undefined),
      backup: h.backup,
      reviewer: h.reviewer,
      reindex: h.reindex,
    });
    expect(res.ran).toEqual(["fire_due_wakeups", "hourly_check", "memory_review", "memory_reindex", "watchdog_ping"]);
    expect(res.memoryReview?.status).toBe("ok");
    expect(res.reindex).toEqual({ indexed: 0, failed: 0, remaining: 0 });
  });

  it("D1: runs persist and the cursor is the latest SUCCESSFUL window_end", async () => {
    const clock = new FixedClock(T0);
    const runs = new D1MemoryRunsRepo(freshDb(), clock);
    const a = await runs.start({ trigger: "hourly_cron", model: "m", windowStart: "2026-09-26T10:00:00.000Z", windowEnd: "2026-09-26T11:00:00.000Z", messagesReviewed: 3, messagesDeferred: 0 });
    await runs.finish(a.id, { status: "ok", factsSaved: 2, factsCorrected: 0, error: null });
    const b = await runs.start({ trigger: "quiet_alarm", model: "m", windowStart: "2026-09-26T11:00:01.000Z", windowEnd: "2026-09-26T11:30:00.000Z", messagesReviewed: 1, messagesDeferred: 0 });
    await runs.finish(b.id, { status: "error", factsSaved: 0, factsCorrected: 0, error: "503" });
    expect(await runs.cursor()).toBe("2026-09-26T11:00:00.000Z");
    expect((await runs.recent(1))[0]!.status).toBe("error");
  });

  it("D1: conversation.since never splits an instant at the cap (moves it to the next run)", async () => {
    const clock = new FixedClock(T0);
    const convo = new D1ConversationRepo(freshDb(), clock);
    clock.advance(1000);
    await convo.append("user", "a", "text");
    clock.advance(1000);
    await convo.append("user", "b", "text");
    await convo.append("user", "c", "text"); // same instant as b
    const win = await convo.since(T0, 2);
    expect(win.messages.map((m) => m.content)).toEqual(["a"]);
    expect(win.deferred).toBe(2);
  });

  it("D1: when every message up to the cap shares one instant, the window covers that instant (none skipped forever)", async () => {
    const clock = new FixedClock(T0);
    const convo = new D1ConversationRepo(freshDb(), clock);
    clock.advance(1000);
    await convo.append("user", "b", "text");
    await convo.append("user", "c", "text");
    await convo.append("user", "d", "text"); // b, c, d share one instant
    clock.advance(1000);
    await convo.append("user", "e", "text");
    const win = await convo.since(T0, 1);
    expect(win.messages.map((m) => m.content)).toEqual(["b", "c", "d"]);
    expect(win.deferred).toBe(1);
    const next = await convo.since(win.messages[2]!.createdAt, 1);
    expect(next.messages.map((m) => m.content)).toEqual(["e"]);
  });

  it("in-memory store: the same instant rule", async () => {
    const clock = new FixedClock(T0);
    const convo = new ConversationRepo(clock);
    clock.advance(1000);
    await convo.append("user", "b", "text");
    await convo.append("user", "c", "text");
    const win = await convo.since(T0, 1);
    expect(win.messages.map((m) => m.content)).toEqual(["b", "c"]);
    expect(win.deferred).toBe(0);
  });
});

describe("meaning index: Vectorize adapter, honest failure, re-index", () => {
  it("CloudflareVectorizeIndex speaks the Vectorize V2 binding shape and clamps topK to 100", async () => {
    const calls: unknown[] = [];
    const fake: VectorizeLike = {
      upsert: async (v) => void calls.push(["upsert", v]),
      deleteByIds: async (ids) => void calls.push(["delete", ids]),
      query: async (vector, opts) => {
        calls.push(["query", vector.length, opts]);
        return { matches: [{ id: "fact_1", score: 0.9 }] };
      },
    };
    const idx = new CloudflareVectorizeIndex(fake);
    await idx.upsert("fact_1", [0.1, 0.2]);
    await idx.remove("fact_1");
    const hits = await idx.query([0.1, 0.2], 500);
    expect(hits).toEqual([{ id: "fact_1", score: 0.9 }]);
    expect(calls).toEqual([
      ["upsert", [{ id: "fact_1", values: [0.1, 0.2] }]],
      ["delete", ["fact_1"]],
      ["query", 2, { topK: 100, returnValues: false, returnMetadata: "none" }],
    ]);
  });

  it("without Workers AI: the fact is SAVED but reported unindexed; search says unavailable; re-index fixes it later", async () => {
    let down = true;
    const real = new FakeEmbeddingProvider();
    const flaky: EmbeddingProvider = {
      embed: (t) => (down ? new UnavailableEmbeddingProvider().embed() : real.embed(t)),
    };
    const h = makeHarness([], { embeddings: flaky });
    const ctx = h.ctxFor(ownerEvent("x"));
    const saved = await memorySave.run({ text: "Sid hates mornings", kind: "durable", confidence: "inferred" }, ctx);
    expect(saved.ok).toBe(true);
    expect((saved.data as any).indexed).toBe(false);
    expect(saved.message).toContain("NOT yet in meaning search");
    expect((await memorySearch.run({ query: "mornings", limit: 3 }, ctx)).status).toBe("error");

    down = false;
    const before = await memorySearch.run({ query: "mornings", limit: 3 }, ctx);
    expect((before.data as any).results).toHaveLength(0);
    expect((before.data as any).notYetIndexed).toBe(1); // empty is NOT "nothing remembered"
    expect(await h.reindex()).toEqual({ indexed: 1, failed: [], remaining: 0 });
    const after = await memorySearch.run({ query: "mornings", limit: 3 }, ctx);
    expect((after.data as any).results.map((r: any) => r.text)).toEqual(["Sid hates mornings"]);
    expect((after.data as any).notYetIndexed).toBe(0);
  });

  it("D1: markIndexed / unindexedActive skip hidden and superseded facts", async () => {
    const clock = new FixedClock(T0);
    const facts = new D1FactsRepo(freshDb(), clock);
    const a = await facts.save({ text: "a", kind: "durable", confidence: "inferred", sourceType: "conversation", sourceRef: "r", expiresAt: null });
    const b = await facts.save({ text: "b", kind: "durable", confidence: "inferred", sourceType: "conversation", sourceRef: "r", expiresAt: null });
    await facts.forget(b.id);
    expect((await facts.unindexedActive(10)).facts.map((f) => f.id)).toEqual([a.id]);
    await facts.markIndexed(a.id, true);
    expect(await facts.unindexedActive(10)).toEqual({ facts: [], total: 0 });
  });
});

describe("archive, R2 and backup wiring", () => {
  it("every live message (Sid's and Jarvis's) lands in the archive and is searchable", async () => {
    const h = makeHarness([{ content: "Got it, Friday." }]);
    await h.agent.handle(ownerEvent("essay due Friday"));
    const res = await archiveSearch.run({ query: "friday" }, h.ctxFor(ownerEvent("x")));
    expect((res.data as any).results.map((r: any) => r.role)).toEqual(["user", "assistant"]);
  });

  it("an archive failure is a receipt; the reply still goes out", async () => {
    const broken: Bucket = {
      put: async () => {
        throw new Error("R2 down");
      },
      get: async () => null,
      list: async () => [],
    };
    const h = makeHarness([{ content: "hi" }], { bucket: broken });
    const res = await h.agent.handle(ownerEvent("hello"));
    expect(res.reply).toBe("hi");
    const failures = (await h.receipts.all()).filter((r) => r.tool === "archive_append");
    expect(failures).toHaveLength(2);
    expect(failures[0]!.resultJson).toContain("R2 down");
  });

  it("R2 list follows the cursor past the 1000-key page (no silent truncation)", async () => {
    const keys = Array.from({ length: 2500 }, (_, i) => `archive/2026-09-26/${String(i).padStart(5, "0")}.json`);
    const r2: R2Like = {
      put: async () => undefined,
      get: async () => null,
      list: async ({ cursor }) => {
        const start = cursor ? Number(cursor) : 0;
        const page = keys.slice(start, start + 1000);
        const next = start + 1000;
        return { objects: page.map((key) => ({ key })), truncated: next < keys.length, ...(next < keys.length ? { cursor: String(next) } : {}) };
      },
    };
    expect(await new R2BucketAdapter(r2).list("archive/")).toHaveLength(2500);
  });

  it("the D1 backup dumps EVERY table, including messages and memory_runs", async () => {
    const db = freshDb();
    const clock = new FixedClock(T0);
    await new D1ConversationRepo(db, clock).append("user", "hello", "text");
    const bucket = new InMemoryBucket();
    const { key, counts } = await BackupService.fromD1(bucket, clock, db).exportAll();
    for (const t of ["facts", "messages", "receipts", "pending_actions", "wakeups", "memory_runs", "school_evidence", "app_events", "heartbeats"]) {
      expect(counts).toHaveProperty(t);
    }
    expect(counts.messages).toBe(1);
    expect(JSON.parse((await bucket.get(key))!).tables.messages[0].content).toBe("hello");
  });
});

describe("wake-ups that fail are kept, not dropped", () => {
  it("a failing wake-up stays queued, the others still fire, and the alarm retries after a floor", async () => {
    const clock = new FixedClock(T0);
    const alarm = vi.fn();
    const sched = new WakeupScheduler(new WakeupsRepo(clock), clock, alarm);
    await sched.schedule("2026-09-26T11:00:00.000Z", "bad");
    await sched.schedule("2026-09-26T11:30:00.000Z", "good");
    const res = await sched.fireDue(async (w) => {
      if (w.reason === "bad") throw new Error("model down");
    });
    expect(res.fired).toBe(1);
    expect(res.failed.map((f) => f.error)).toEqual(["model down"]);
    expect((await sched.list()).map((w) => w.reason)).toEqual(["bad"]);
    expect(alarm).toHaveBeenLastCalledWith(new Date(Date.parse(T0) + RETRY_FLOOR_MS).toISOString());
  });

  it("an owner wake-up whose model call errors THROWS so the scheduler keeps it", async () => {
    const h = makeHarness([
      () => {
        throw new Error("deepseek 500");
      },
    ]);
    const w = await h.wakeups.schedule(T0, "remind Sid about the essay");
    await expect(fireWakeup(w, { agent: h.agent, reviewer: h.reviewer })).rejects.toThrow("deepseek 500");
  });
});
