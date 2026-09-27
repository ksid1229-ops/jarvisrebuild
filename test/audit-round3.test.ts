import { describe, expect, it } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { wakeOnAppEvent } from "../src/apps/app-events.js";
import { buildSystemPrompt } from "../src/jarvis/system-prompt.js";
import { memorySave } from "../src/memory/memory-tools.js";
import { connectApp } from "../src/apps/app-tools.js";
import type { AppConnector, AppToolSpec } from "../src/apps/connector.js";
import { TelegramChannel } from "../src/channels/telegram-channel.js";
import { TwilioRestClient } from "../src/channels/twilio-rest.js";
import type { ConnectedApp } from "../src/types.js";

/**
 * Audit round 3 — every fix verified by a falsifier: each test names the
 * defect it kills. All 7 new guards were mutation-checked on 2026-09-26:
 * each defect planted back, the suite went red, the defect reverted.
 *
 * Claims verified against HEAD 786c0d6 first (round-1 lesson: audits go
 * stale). Stale — already fixed on this branch, not re-fixed, each with an
 * existing test: the substring quote (round 2), self-certified "confirmed"
 * (round 2), the unset alarm / missing alarm() handler (round 1), backup
 * pending_actions () => [] (round 2), isForwarded dropped before the prompt
 * (round 2), heartbeat written but never read (pc_status reads it), and
 * R2BucketAdapter first-page-only (cursor-following loop, tested at 2500
 * keys). Real and fixed below: the app-event provenance wire, the app-owned
 * confirmable flag hidden from Sid's confirmation, and the missing send
 * timeouts on both text reply paths.
 */

// ---------------------------------------------------------------------------
// 1. An app's payload must reach the model as an APP EVENT, not as Sid's words
// ---------------------------------------------------------------------------

describe("audit 3: an app event is labelled as not-Sid's-words in the prompt", () => {
  it("the prompt says AUTOMATED EVENT on an app-event wake, and not otherwise", async () => {
    const h = makeHarness([{ content: "x" }]);
    await wakeOnAppEvent(
      h.agent,
      { id: "appevt_1", appName: "testapp", payloadJson: JSON.stringify({ grade: 90 }), receivedAt: "2026-09-26T12:00:00.000Z" },
      "sid",
    );
    const system = h.model.requests[0]!.messages[0]!.content;
    expect(system).toContain("AUTOMATED EVENT");
    expect(system).toContain("'testapp'");
    expect(system).toContain("NOT Sid's words");
    expect(system).toContain("'inferred', never 'stated'");

    const h2 = makeHarness([{ content: "x" }]);
    await h2.agent.handle(ownerEvent("plain message from Sid"));
    expect(h2.model.requests[0]!.messages[0]!.content).not.toContain("AUTOMATED EVENT");
  });

  it("buildSystemPrompt renders the line only when sourceApp is set", () => {
    const base = { nowIso: "2026-09-26T12:00:00.000Z", timezone: "America/Toronto", channel: "text" as const, shadow: false, pinnedFacts: [] };
    expect(buildSystemPrompt(base)).not.toContain("AUTOMATED EVENT");
    expect(buildSystemPrompt({ ...base, sourceApp: "school" })).toContain("AUTOMATED EVENT");
    expect(buildSystemPrompt({ ...base, sourceApp: "school" })).toContain("'school'");
  });

  it("a stated fact still cannot be quoted from an app-event turn (guard kept loud)", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ev = ownerEvent("Event from connected app 'testapp': I got the iPhone 16", "e1", {
      trigger: "app_event",
      provenance: { sourceType: "app", sourceName: "testapp" },
    });
    const ctx = h.ctxFor(ev);
    const res = await h.dispatcher.dispatch(
      "memory_save",
      { text: "Sid got the iPhone 16", kind: "durable", confidence: "stated", quote: "I got the iPhone 16" },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.message ?? "").toContain("not a live message from Sid");
  });
});

// ---------------------------------------------------------------------------
// 2. connect_app's confirmation must show Sid what he is trusting
// ---------------------------------------------------------------------------

/** A fake connector with one free tool and one confirmable tool. */
function fakeConnector(specs: AppToolSpec[] | Error): (app: ConnectedApp) => AppConnector {
  return () => ({
    listTools: async () => {
      if (specs instanceof Error) throw specs;
      return specs;
    },
    callTool: async () => ({ ok: true, status: "ok" }),
  });
}

const SPECS: AppToolSpec[] = [
  { name: "pull_grades", description: "pull grades", parameters: { type: "object", properties: {} }, confirmable: false },
  { name: "submit_homework", description: "submit", parameters: { type: "object", properties: {} }, confirmable: true },
];

describe("audit 3: the connect confirmation lists the app's tools and their trust level", () => {
  it("the confirmation Sid receives names every tool and says which run freely", async () => {
    const h = makeHarness([{ content: "x" }], { makeConnector: fakeConnector(SPECS) });
    h.dispatcher.register(connectApp);
    const ctx = h.ctxFor(ownerEvent("connect the testapp app", "e1"));
    const res = await h.dispatcher.dispatch(
      "connect_app",
      { name: "testapp", base_url: "https://app.example", auth_secret: "s3", confirmation_summary: "connect testapp" },
      ctx,
    );
    expect(res.status).toBe("confirmation_requested");
    const ask = h.ownerChannel.sent.at(-1)!;
    expect(ask).toContain("pull_grades");
    expect(ask).toContain("runs freely");
    expect(ask).toContain("submit_homework");
    expect(ask).toContain("asks you first");
    expect(ask).toContain("What you are trusting");
  });

  it("nothing is connected before Sid confirms, and after YES the tools load", async () => {
    const h = makeHarness([{ content: "x" }], { makeConnector: fakeConnector(SPECS) });
    h.dispatcher.register(connectApp);
    const ctx = h.ctxFor(ownerEvent("connect the testapp app", "e1"));
    await h.dispatcher.dispatch("connect_app", { name: "testapp", base_url: "https://app.example", auth_secret: "s3" }, ctx);
    expect(await h.apps.list()).toHaveLength(0); // nothing registered yet

    const pendingId = (h.pending as unknown as { actions: Map<string, unknown> }).actions.keys().next().value as string;
    const done = await h.dispatcher.executeConfirmed(pendingId, h.ctxFor(ownerEvent("yes", "e2")));
    expect(done.ok).toBe(true);
    expect(await h.apps.list()).toHaveLength(1);
    // The app's tools are in the catalogue under the app's namespace.
    const pulled = await h.dispatcher.dispatch("testapp.pull_grades", {}, h.ctxFor(ownerEvent("pull", "e3")));
    expect(pulled.ok).toBe(true);
  });

  it("a pre-check failure (app /tools down) refuses the connect outright — no pending action", async () => {
    const h = makeHarness([{ content: "x" }], { makeConnector: fakeConnector(new Error("app /tools returned 503")) });
    h.dispatcher.register(connectApp);
    const ctx = h.ctxFor(ownerEvent("connect the testapp app", "e1"));
    const res = await h.dispatcher.dispatch("connect_app", { name: "testapp", base_url: "https://app.example", auth_secret: "s3" }, ctx);
    expect(res.status).toBe("precheck_failed");
    expect(res.message ?? "").toContain("nothing was done");
    expect((h.pending as unknown as { actions: Map<string, unknown> }).actions.size).toBe(0);
    expect(h.ownerChannel.sent).toHaveLength(0); // Sid was not asked to confirm a broken connect
  });
});

// ---------------------------------------------------------------------------
// 3. Send timeouts on every turn's reply path
// ---------------------------------------------------------------------------

/** A fetch that hangs forever — until its abort signal fires, like real fetch. */
function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
    })) as unknown as typeof fetch;
}

describe("audit 3: a hung Telegram or Twilio connection cannot hang the turn", () => {
  it("TelegramChannel.sendText gives up at the timeout with an honest status", async () => {
    const ch = new TelegramChannel("tok", "chat", hangingFetch(), 25);
    const t0 = Date.now();
    const res = await ch.sendText("hello");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.ok).toBe(false);
    expect(res.status).toBe("timeout");
    expect(res.detail ?? "").toContain("25ms");
  });

  it("TwilioRestClient.sendSms gives up at the timeout with an honest status", async () => {
    const client = new TwilioRestClient(
      { accountSid: "AC1", authToken: "tok", fromE164: "+14165550001" },
      hangingFetch(),
      25,
    );
    const t0 = Date.now();
    const res = await client.sendSms("+14165551234", "hello");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.ok).toBe(false);
    expect(res.status).toBe("timeout");
  });

  it("fast, healthy APIs are unaffected (10s default, happy path still ok)", async () => {
    const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const tg = new TelegramChannel("tok", "chat", ok);
    expect((await tg.sendText("hello")).ok).toBe(true);
    const tw = new TwilioRestClient({ accountSid: "AC1", authToken: "tok", fromE164: "+14165550001" }, ok);
    expect((await tw.sendSms("+14165551234", "hello")).ok).toBe(true);
  });
});
