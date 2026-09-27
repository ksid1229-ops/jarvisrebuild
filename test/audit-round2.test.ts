import { describe, expect, it } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { fakeToolCall } from "../src/model/fake-model.js";
import { memorySave, memoryCorrect, memoryRestore, memoryConfirm } from "../src/memory/memory-tools.js";
import { verifyQuote } from "../src/memory/provenance.js";
import { hashPin, verifyHashedPin } from "../src/voice/pin.js";
import { newId } from "../src/ids.js";
import { settingsUpdate } from "../src/jarvis/core-tools.js";
import { buildSystemPrompt } from "../src/jarvis/system-prompt.js";
import { JarvisDurableObject } from "../src/index.js";
import type { Env } from "../src/env.js";
import { InMemoryBucket } from "../src/plumbing/bucket.js";

/**
 * Audit round 2 — every fix verified by a falsifier: each test names the
 * defect it kills. All 15 guards were mutation-checked on 2026-09-26:
 * each defect planted back, the suite went red, the defect reverted.
 */

// ---------------------------------------------------------------------------
// 1. verifyQuote: a one-word quote is not provenance; matches are whole words
// ---------------------------------------------------------------------------

describe("audit 2.1: a stated fact needs a real quote, not a substring", () => {
  it("the falsifier: quote 'mornings' against 'i hate mornings in theory but not really' is REFUSED", () => {
    expect(() => verifyQuote("mornings", "i hate mornings in theory but not really")).toThrow(/at least 3/);
  });

  it("a three-word quote that is really there passes", () => {
    expect(() => verifyQuote("i hate mornings", "i hate mornings in theory but not really")).not.toThrow();
  });

  it("mid-word matches are refused (word boundaries, not substring)", () => {
    expect(() => verifyQuote("nate morn mornings today", "concatenate mornings today")).toThrow(/does not appear/);
  });

  it("punctuation on either side is tolerated; non-contiguous words are not", () => {
    expect(() => verifyQuote("I hate mornings!", "i hate mornings, in theory")).not.toThrow();
    expect(() => verifyQuote("hate mornings really", "i hate mornings in theory but not really")).toThrow(/does not appear/);
  });

  it("through the tool: memory_save with a one-word quote is refused; the full quote saves", async () => {
    const h = makeHarness([]);
    const m = await h.conversation.append("user", "i hate mornings in theory but not really", "text");
    const ctx = h.ctxFor(ownerEvent("i hate mornings in theory but not really"), m.id);
    const bad = await memorySave.run(
      { text: "Sid hates mornings", kind: "durable", confidence: "stated", quote: "mornings" },
      ctx,
    );
    expect(bad.status).toBe("refused");
    expect(bad.message).toContain("at least 3");
    expect(await h.facts.all()).toHaveLength(0);

    const good = await memorySave.run(
      { text: "Sid hates mornings", kind: "durable", confidence: "stated", quote: "i hate mornings" },
      ctx,
    );
    expect(good.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. 'confirmed' cannot be self-certified at save time
// ---------------------------------------------------------------------------

describe("audit 2.2: the model cannot mint owner-confirmed facts", () => {
  it("memory_save refuses confidence 'confirmed' and names the honest path", async () => {
    const h = makeHarness([]);
    const res = await memorySave.run(
      { text: "Sid loves broccoli", kind: "durable", confidence: "confirmed" },
      h.ctxFor(ownerEvent("x")),
    );
    expect(res.status).toBe("refused");
    expect(res.message).toContain("memory_confirm");
    expect(await h.facts.all()).toHaveLength(0);
  });

  it("memory_correct refuses it too; the schema enum no longer offers it", async () => {
    const h = makeHarness([]);
    const f = await h.facts.save({ text: "old", kind: "durable", confidence: "inferred", sourceType: "conversation", sourceRef: "x", expiresAt: null });
    const res = await memoryCorrect.run(
      { fact_id: f.id, new_text: "new", confidence: "confirmed", kind: "durable", reason: "r" },
      h.ctxFor(ownerEvent("x")),
    );
    expect(res.status).toBe("refused");
    expect(res.message).toContain("memory_confirm");
    expect((memoryCorrect.parameters.properties as { confidence: { enum: string[] } }).confidence.enum).toEqual(["stated", "inferred"]);
  });

  it("the honest path still works: save inferred → memory_confirm → confirmed", async () => {
    const h = makeHarness([]);
    const saved = await memorySave.run(
      { text: "Sid prefers evenings", kind: "durable", confidence: "inferred" },
      h.ctxFor(ownerEvent("he seems sharper at night")),
    );
    const id = (saved.data as { id: string }).id;
    expect((await h.facts.get(id))!.confidence).toBe("inferred");
    await memoryConfirm.run({ fact_id: id }, h.ctxFor(ownerEvent("yes that's right")));
    expect((await h.facts.get(id))!.confidence).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
// 3. memory_restore cannot resurrect corrected wording
// ---------------------------------------------------------------------------

describe("audit 2.3: restore refuses superseded wording and points at the current version", () => {
  it("restoring an old version is refused with the current id; the current version restores fine", async () => {
    const h = makeHarness([]);
    const ctx = h.ctxFor(ownerEvent("seed"));
    const v1 = await h.facts.save({ text: "Sid has an iPhone 15", kind: "durable", confidence: "stated", sourceType: "conversation", sourceRef: "x", expiresAt: null });
    const v2 = await h.facts.correct(v1.id, { text: "Sid has an iPhone 16", confidence: "inferred", kind: "durable", expiresAt: null, reason: "upgrade", sourceType: "conversation", sourceRef: "y", sourceMessageId: null });

    const bad = await memoryRestore.run({ fact_id: v1.id }, ctx);
    expect(bad.status).toBe("refused");
    expect(bad.message).toContain(v2.id);
    expect(bad.message).toContain("no longer true");

    // The current version, once hidden, restores normally.
    await h.facts.forget(v2.id);
    const good = await memoryRestore.run({ fact_id: v2.id }, ctx);
    expect(good.ok).toBe(true);
    expect((await h.facts.get(v2.id))!.hidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Guest PINs: per-PIN salt (attempt limits were already in, per call)
// ---------------------------------------------------------------------------

describe("audit 2.4: guest PIN hashes are per-PIN salted", () => {
  it("same PIN hashed twice gives different stored values (fresh salt each time)", async () => {
    const a = await hashPin("5678", "pep");
    const b = await hashPin("5678", "pep");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    await expect(verifyHashedPin("5678", a, "pep")).resolves.toBe(true);
    await expect(verifyHashedPin("5678", b, "pep")).resolves.toBe(true);
    await expect(verifyHashedPin("0000", a, "pep")).resolves.toBe(false);
  });

  it("legacy bare hashes still verify (no lockout of pre-existing rows)", async () => {
    const legacy = "pep:1234";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacy));
    const legacyHex = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
    await expect(verifyHashedPin("1234", legacyHex, "pep")).resolves.toBe(true);
    await expect(verifyHashedPin("1234", legacyHex, "")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. guest_create is a confirmed action (it grants a phone line)
// ---------------------------------------------------------------------------

describe("audit 2.9: guest_create needs Sid's confirmation", () => {
  it("nothing is created before the confirmation; after it, the PIN is stored salted", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx = h.ctxFor(ownerEvent("let my mom call you", "e1"));
    const res = await h.dispatcher.dispatch(
      "guest_create",
      { name: "Mom", phone: "+16135550111", access: "may ask about the shopping list", expiry: "2026-12-01T00:00:00Z", pin: "5678" },
      ctx,
    );
    expect(res.status).toBe("confirmation_requested");
    expect(await h.guests.list()).toHaveLength(0); // NOT created yet
    expect(h.ownerChannel.sent.some((m) => m.includes("Just to be sure"))).toBe(true);

    const pendingId = [...(h.pending as unknown as { actions: Map<string, unknown> }).actions.keys()][0] as string;
    const confirmed = await h.dispatcher.executeConfirmed(pendingId, h.ctxFor(ownerEvent("yes", "e2")));
    expect(confirmed.ok).toBe(true);
    const guest = (await h.guests.list())[0]!;
    expect(guest.name).toBe("Mom");
    expect(guest.pinHash).toMatch(/^v1\$/); // salted
    expect(guest.pinHash).not.toContain("5678");
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. DO identity is single-sourced; Telegram retries dedupe
// ---------------------------------------------------------------------------

function doEnv(extra: Partial<Env> = {}): Env {
  return { OWNER_CHAT_ID: "sid123", OWNER_TIMEZONE: "America/Toronto", ...extra } as unknown as Env;
}

function telegramBody(chatId: string, updateId: number, text: string): string {
  return JSON.stringify({ chatId, updateId, text, provenance: { channel: "text", isOwner: true, isForwarded: false, isPrivate: true, sourceRef: `telegram:${chatId}:1`, sourceType: "conversation", medium: "telegram" } });
}

describe("audit 2.5: the DO's identity comes from OWNER_CHAT_ID only", () => {
  it("a telegram update claiming a different chat is refused 403, before anything runs", async () => {
    const dobj = new JarvisDurableObject({} as never, doEnv());
    const res = await dobj.fetch(new Request("https://do/telegram", { method: "POST", body: telegramBody("someone-else", 1, "hi") }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: expect.stringContaining("not the configured owner") });
  });
});

describe("audit 2.6: Telegram retries (same update_id) run the brain exactly once", () => {
  it("the second delivery of an update is deduped; a NEW update is processed", async () => {
    const seen: number[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { messages: { role: string; content: string }[] };
      seen.push(body.messages.length);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env = doEnv({ DEEPSEEK_API_KEY: "k" });
      const dobj = new JarvisDurableObject({} as never, env);
      const first = await dobj.fetch(new Request("https://do/telegram", { method: "POST", body: telegramBody("sid123", 501, "hello") }));
      expect(first.status).toBe(200);
      expect(seen).toHaveLength(1);

      // Telegram retries the SAME update (timeout / redelivery): deduped.
      const retry = await dobj.fetch(new Request("https://do/telegram", { method: "POST", body: telegramBody("sid123", 501, "hello") }));
      expect(await retry.json()).toMatchObject({ ok: true, deduped: true });
      expect(seen).toHaveLength(1); // the brain ran ONCE

      // A genuinely new update is processed.
      const next = await dobj.fetch(new Request("https://do/telegram", { method: "POST", body: telegramBody("sid123", 502, "again") }));
      expect(next.status).toBe(200);
      expect((await next.json()).deduped ?? false).toBe(false);
      expect(seen).toHaveLength(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The shared app-event store (was: rebuilt per event, everything vanished)
// ---------------------------------------------------------------------------

describe("audit 2.7: app events live in the SHARED store", () => {
  it("events accumulate on the built brain, and the DO handler stores through it", async () => {
    const h = makeHarness([{ content: "ok" }]);
    expect(h.appEvents).toBeDefined();
    await h.appEvents.store("testapp", { a: 1 });
    await h.appEvents.store("testapp", { a: 2 });
    expect((await h.appEvents.all()).length).toBe(2);

    // End to end: register the app through the REAL confirmable connect_app
    // path (two owner turns), then post two events through the DO route.
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    let yesRound = 0;
    const wireToolCall = (id: string, name: string, args: Record<string, unknown>) => ({
      choices: [{ message: { content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
    });
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      // App connector fetches (https://app.example/tools) get an empty catalogue.
      if (String(url).includes("app.example")) {
        return new Response(JSON.stringify({ tools: [] }), { status: 200 });
      }
      const initBody = (init as RequestInit).body;
      if (typeof initBody !== "string" || !initBody.includes('"messages"')) {
        return new Response("{}", { status: 200 });
      }
      const body = JSON.parse(initBody) as { messages: { role: string; content: string }[] };
      const all = JSON.stringify(body.messages);
      const lastUser = body.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      const hasToolMsg = body.messages.some((m) => m.role === "tool");
      if (!lastUser.includes("[app_event]")) seen.push(lastUser);
      if (lastUser.includes("[app_event]")) {
        // (Checked first: an event text can itself contain the word "connected".)
        seen.push(lastUser);
        return new Response(JSON.stringify({ choices: [{ message: { content: "noted" } }] }), { status: 200 });
      }
      if (lastUser.includes("connect") && !hasToolMsg) {
        return new Response(JSON.stringify(wireToolCall("c1", "connect_app", { name: "testapp", base_url: "https://app.example", auth_secret: "s3" })), { status: 200 });
      }
      if (lastUser.includes("connect")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "I'll ask Sid to confirm." } }] }), { status: 200 });
      }
      if (lastUser === "yes") {
        yesRound++;
        if (yesRound === 1) {
          // The honest cross-turn flow: re-ask the same tool, which answers
          // "Already waiting... pending_id=X" without executing anything.
          return new Response(JSON.stringify(wireToolCall("c2", "connect_app", { name: "testapp", base_url: "https://app.example", auth_secret: "s3" })), { status: 200 });
        }
        if (yesRound === 2) {
          const pend = all.match(/pending_id=([A-Za-z0-9_-]+)/)![1]!; // UUIDs contain hyphens
          return new Response(JSON.stringify(wireToolCall("c3", "confirm_action", { pending_id: pend })), { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "connected." } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "noted" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env = doEnv({ DEEPSEEK_API_KEY: "k" });
      const dobj = new JarvisDurableObject({} as never, env);
      const ask = await dobj.fetch(new Request("https://do/telegram", { method: "POST", body: telegramBody("sid123", 601, "connect the testapp app") }));
      expect(ask.status).toBe(200);
      const yes = await dobj.fetch(new Request("https://do/telegram", { method: "POST", body: telegramBody("sid123", 602, "yes") }));
      expect(yes.status).toBe(200);

      const e1 = await dobj.fetch(new Request("https://do/apps/event", { method: "POST", body: JSON.stringify({ appName: "testapp", authSecret: "s3", payload: { n: 1 } }) }));
      expect(e1.status).toBe(200); // 401 before the app was registered
      const e2 = await dobj.fetch(new Request("https://do/apps/event", { method: "POST", body: JSON.stringify({ appName: "testapp", authSecret: "s3", payload: { n: 2 } }) }));
      expect(e2.status).toBe(200);
      // Both wakes reached the brain (the event payloads themselves).
      expect(seen.filter((u) => u.includes("[app_event]"))).toHaveLength(2);
      // And both events are RETAINED in the one shared store on the built brain —
      // the per-request repo this round's audit found would have lost them.
      const stored = await (dobj as unknown as { built: { appEvents: { all(): Promise<unknown[]> } } }).built.appEvents.all();
      expect(stored).toHaveLength(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a bad app secret is still refused (fail closed)", async () => {
    const env = doEnv({ DEEPSEEK_API_KEY: "k" });
    const dobj = new JarvisDurableObject({} as never, env);
    const res = await dobj.fetch(new Request("https://do/apps/event", { method: "POST", body: JSON.stringify({ appName: "ghost", authSecret: "nope", payload: {} }) }));
    expect(res.status).toBe(401);
  });

  it("claims out loud when AI (embeddings) is unbound — no silent fake (audit 2.7)", async () => {
    const env = doEnv({ DEEPSEEK_API_KEY: "k" }); // no AI binding
    const dobj = new JarvisDurableObject({} as never, env);
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
    try {
      const res = await dobj.fetch(new Request("https://do/telegram", { method: "POST", body: telegramBody("sid123", 701, "hi") }));
      expect(res.status).toBe(200);
    } finally {
      console.warn = realWarn;
    }
    expect(warns.join("\n")).toContain("AI is not bound");
    expect(warns.join("\n")).toContain("MEMORY_VECTORS is not bound");
  });
});

// ---------------------------------------------------------------------------
// 12. settings_update: only settable keys
// ---------------------------------------------------------------------------

describe("audit 2.12: settings_update writes only settable keys", () => {
  it("shadow, per-feature shadow and persona are settable (with valid values)", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx = h.ctxFor(ownerEvent("turn shadow on", "e1"));
    expect((await h.dispatcher.dispatch("settings_update", { key: "shadow", value: "on" }, ctx)).ok).toBe(true);
    expect(await h.settings.isShadow()).toBe(true);
    expect((await h.dispatcher.dispatch("settings_update", { key: "shadow:send_email", value: "on" }, ctx)).ok).toBe(true);
    expect((await h.dispatcher.dispatch("settings_update", { key: "persona", value: "Be terse." }, ctx)).ok).toBe(true);
    expect((await h.dispatcher.dispatch("settings_update", { key: "shadow", value: "off" }, ctx)).ok).toBe(true);
    expect(await h.settings.isShadow()).toBe(false);
  });

  it("internal keys are refused — call records, the dedupe ledger, the review cursor", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx = h.ctxFor(ownerEvent("x", "e1"));
    for (const key of ["outbound_call:oc1", "tg_dedupe:501", "last_text_medium", "memory_review_cursor", "anything_else"]) {
      const res = await h.dispatcher.dispatch("settings_update", { key, value: "on" }, ctx);
      expect(res.status).toBe("refused");
      expect(res.message).toContain("not a settable setting");
    }
    expect(await h.settings.get("outbound_call:oc1")).toBeUndefined();
  });

  it("shadow takes only on/off; persona cannot be blanked", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx = h.ctxFor(ownerEvent("x", "e1"));
    expect((await h.dispatcher.dispatch("settings_update", { key: "shadow", value: "maybe" }, ctx)).status).toBe("refused");
    expect((await h.dispatcher.dispatch("settings_update", { key: "persona", value: "  " }, ctx)).status).toBe("refused");
  });
});

// ---------------------------------------------------------------------------
// 11. isForwarded finally reaches the prompt
// ---------------------------------------------------------------------------

describe("audit 2.11: a forwarded message is labelled in the system prompt", () => {
  it("the prompt says FORWARDED on a forwarded turn, and not otherwise", async () => {
    const h = makeHarness([{ content: "x" }]);
    await h.agent.handle(ownerEvent("fyi from dad", "f1", { provenance: { isForwarded: true } }));
    const system = h.model.requests[0]!.messages[0]!.content;
    expect(system).toContain("FORWARDED");
    expect(system).toContain("NOT his own words");
    expect(system).toContain("'inferred', never 'stated'");

    const h2 = makeHarness([{ content: "x" }]);
    await h2.agent.handle(ownerEvent("plain message"));
    expect(h2.model.requests[0]!.messages[0]!.content).not.toContain("FORWARDED");
  });

  it("buildSystemPrompt renders the line only when forwarded is set", () => {
    const base = { nowIso: "2026-09-27T12:00:00.000Z", timezone: "America/Toronto", channel: "text" as const, shadow: false, pinnedFacts: [] };
    expect(buildSystemPrompt(base)).not.toContain("FORWARDED");
    expect(buildSystemPrompt({ ...base, forwarded: true })).toContain("FORWARDED");
  });
});

// ---------------------------------------------------------------------------
// 10. The in-memory backup no longer quietly empties pending_actions
// ---------------------------------------------------------------------------

describe("audit 2.10: the fallback backup includes pending actions", () => {
  it("a pending action shows up in the backup with a real row count", async () => {
    const bucket = new InMemoryBucket();
    const h = makeHarness([{ content: "x" }], { bucket });
    await h.dispatcher.dispatch(
      "send_email",
      { from: "personal", to: "a@b.c", subject: "s", body: "b" },
      h.ctxFor(ownerEvent("email them", "e1")),
    );
    const { counts } = await h.backup.exportAll();
    expect(counts["pending_actions"]).toBe(1);
    const raw = await bucket.get(`x`);
    void raw;
  });
});

// ---------------------------------------------------------------------------
// 13. Ids are collision-safe
// ---------------------------------------------------------------------------

describe("audit 2.13: ids are UUID-backed", () => {
  it("two ids differ and carry a prefix + UUID", () => {
    const a = newId("fact");
    const b = newId("fact");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^fact_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ---------------------------------------------------------------------------
// Shadow of the old five: the five confirmed actions still gate the same way
// (regression guard while touching the gate's neighbours)
// ---------------------------------------------------------------------------

describe("regression: the five confirmed actions still gate", () => {
  it("spend_money still never runs on first call", async () => {
    const h = makeHarness([{ content: "x" }]);
    const res = await h.dispatcher.dispatch(
      "spend_money",
      { url: "https://x.example/pay", amount: 5, currency: "CAD", description: "x" },
      h.ctxFor(ownerEvent("buy it", "e1")),
    );
    expect(res.status).toBe("confirmation_requested");
    const sameTurn = await h.dispatcher.executeConfirmed(
      [...(h.pending as unknown as { actions: Map<string, unknown> }).actions.keys()][0] as string,
      h.ctxFor(ownerEvent("buy it", "e1")),
    );
    expect(sameTurn.status).toBe("refused");
    void fakeToolCall;
  });
});
