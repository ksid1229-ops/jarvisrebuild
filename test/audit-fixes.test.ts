import { describe, expect, it } from "vitest";
import { makeHarness, callEvent, newCallSession } from "./helpers.js";
import { freshDb } from "./d1-testkit.js";
import { fakeToolCall } from "../src/model/fake-model.js";
import type { ModelRequest } from "../src/model/types.js";
import { DeepSeekModel } from "../src/model/deepseek.js";
import { FixedClock } from "../src/clock.js";
import { D1PendingActionsRepo } from "../src/confirmations/pending-actions.js";
import { GuestsRepo } from "../src/voice/guests-repo.js";
import { identifyCaller } from "../src/voice/caller-id.js";
import { hashPin, makeOwnerPinVerifier } from "../src/voice/pin.js";
import { MAX_PIN_FAILURES_PER_CALL, verifyOwnerPinOnCall } from "../src/voice/call-auth.js";
import { GUEST_PIN_TOOL } from "../src/jarvis/agent-core.js";
import { twilioSignedUrlCandidates, verifyTwilioSignatureAny } from "../src/voice/twilio-signature.js";
import { buildConnectTwiml } from "../src/voice/twiml.js";
import { TelegramChannel, splitForTelegram, TELEGRAM_MAX_MESSAGE } from "../src/channels/telegram-channel.js";
import { eventTextFor, verifyTelegramWebhook } from "../src/router/telegram-webhook.js";
import { MODEL_DOWN_LINE, VoiceRelay, type RelayOutbound } from "../src/voice/relay.js";
import type { Env } from "../src/env.js";

const HOUR = 3_600_000;

async function twilioSign(token: string, url: string, params: Record<string, string>): Promise<string> {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function pendingIds(h: { pending: { all(): Promise<{ id: string; status: string }[]> } }) {
  return (await h.pending.all()).map((a) => a.id);
}

// ---------------------------------------------------------------------------
// 1.1 Voice PIN dead-end
// ---------------------------------------------------------------------------
describe("audit 1.1: a confirm refused for a missing PIN leaves the action pending", () => {
  for (const kind of ["in-memory", "D1"] as const) {
    it(`pin_required → PIN → confirm again → the action runs (${kind})`, async () => {
      const clock = new FixedClock();
      const h = makeHarness([{ content: "x" }], {
        clock,
        ownerPin: "1234",
        ...(kind === "D1" ? { stores: { pending: new D1PendingActionsRepo(freshDb(), clock) } } : {}),
      });
      const call = newCallSession({ callerId: "+1owner", role: "owner" });
      await h.dispatcher.dispatch("spend_money", { amount: 9, currency: "CAD", description: "x" }, h.ctxFor(callEvent("spend", call, "c1")));
      const [pendingId] = await pendingIds(h);

      const first = await h.dispatcher.executeConfirmed(pendingId!, h.ctxFor(callEvent("yes", call, "c2")));
      expect(first.status).toBe("pin_required");
      // The fix: still pending, not burned to "confirmed".
      expect((await h.pending.get(pendingId!))!.status).toBe("pending");

      const pin = await h.dispatcher.dispatch("pin_verify", { pin: "1234" }, h.ctxFor(callEvent("1234", call, "c3")));
      expect(pin.ok).toBe(true);
      const second = await h.dispatcher.executeConfirmed(pendingId!, h.ctxFor(callEvent("confirm", call, "c4")));
      expect(second.status).toBe("not_connected"); // reached the real tool (honestly unconnected)
      expect((await h.pending.get(pendingId!))!.status).not.toBe("pending");
    });
  }

  it("the authoritative guards still hold after the reorder (unknown id, same turn)", async () => {
    const h = makeHarness([{ content: "x" }], { ownerPin: "1234" });
    const call = newCallSession({ callerId: "+1owner", role: "owner" });
    call.pinVerified = true;
    const unknown = await h.dispatcher.executeConfirmed("pending_nope", h.ctxFor(callEvent("yes", call, "c1")));
    expect(unknown.status).toBe("refused");
    await h.dispatcher.dispatch("spend_money", { amount: 9, currency: "CAD", description: "x" }, h.ctxFor(callEvent("spend", call, "c2")));
    const [pendingId] = await pendingIds(h);
    const sameTurn = await h.dispatcher.executeConfirmed(pendingId!, h.ctxFor(callEvent("spend", call, "c2")));
    expect(sameTurn.status).toBe("refused");
  });
});

// ---------------------------------------------------------------------------
// 1.2 DeepSeek empty tools
// ---------------------------------------------------------------------------
describe("audit 1.2: DeepSeek requests omit tools when there are none", () => {
  function capture() {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { bodies, model: new DeepSeekModel({ apiKey: "k", model: "deepseek-flash", fetchImpl }) };
  }

  it("no tools → neither `tools` nor `tool_choice` is sent", async () => {
    const { bodies, model } = capture();
    await model.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });
    expect("tools" in bodies[0]).toBe(false);
    expect("tool_choice" in bodies[0]).toBe(false);
  });

  it("with tools → both are sent", async () => {
    const { bodies, model } = capture();
    await model.complete({ messages: [{ role: "user", content: "hi" }], tools: [GUEST_PIN_TOOL] });
    expect(bodies[0].tools).toHaveLength(1);
    expect(bodies[0].tool_choice).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// 2.1 Guest PIN
// ---------------------------------------------------------------------------
describe("audit 2.1: a guest's access needs the guest PIN, not just caller ID", () => {
  async function guestSetup(pin = "5678") {
    const clock = new FixedClock();
    const h0 = { clock };
    const guests = new GuestsRepo(clock);
    const g = await guests.create({
      name: "Mom",
      phone: "+1guest",
      pinHash: await hashPin(pin, "pep"),
      access: "May ask whether Sid is free this weekend.",
      expiresAt: new Date(clock.nowMs() + HOUR).toISOString(),
    });
    return { ...h0, guests, g };
  }

  it("identifyCaller withholds access from a matched guest", async () => {
    const { guests, g } = await guestSetup();
    const s = await identifyCaller("+1guest", "+1owner", guests);
    expect(s.role).toBe("guest");
    expect(s.guestId).toBe(g.id);
    expect(s.access).toBe("");
    expect(s.guestVerified).toBe(false);
  });

  it("before the PIN: no access in the prompt and only guest_pin_verify offered; right PIN unlocks access", async () => {
    const { guests, g } = await guestSetup();
    let secondSystem = "";
    const h = makeHarness(
      [
        { content: "", toolCalls: [fakeToolCall("guest_pin_verify", { pin: "5678" })] },
        (req: ModelRequest) => {
          secondSystem = req.messages[0]!.content;
          return { content: "Thanks — Sid is free Saturday.", toolCalls: [] };
        },
      ],
      { pinPepper: "pep", stores: { guests } },
    );
    const call = await identifyCaller("+1guest", "+1owner", guests);
    const res = await h.agent.handle(callEvent("my pin is 5 6 7 8", call, "g1"));
    const first = h.model.requests[0]!;
    expect(first.messages[0]!.content).not.toContain("free this weekend");
    expect(first.messages[0]!.content).not.toContain("Mom");
    expect(first.tools.map((t) => t.name)).toEqual(["guest_pin_verify"]);
    expect(call.guestVerified).toBe(true);
    expect(secondSystem).toContain("free this weekend");
    expect(h.model.requests[1]!.tools).toHaveLength(0); // verified guests get no tools at all
    expect(res.reply).toContain("Saturday");
    // Receipt of the attempt, without the digits.
    const r = (await h.receipts.all()).find((x) => x.tool === "guest_pin_verify")!;
    expect(r.status).toBe("ok");
    expect(r.inputJson + r.resultJson).not.toContain("5678");
    expect(await h.conversation.all()).toHaveLength(0); // still off Sid's memory
    void g;
  });

  it("a wrong PIN keeps access withheld; the limit locks the call even for the right PIN", async () => {
    const { guests } = await guestSetup();
    const wrong = Array.from({ length: MAX_PIN_FAILURES_PER_CALL }, () => ({
      content: "",
      toolCalls: [fakeToolCall("guest_pin_verify", { pin: "0000" })],
    }));
    const h = makeHarness(
      [...wrong.flatMap((w) => [w, { content: "That's not right." }]), { content: "", toolCalls: [fakeToolCall("guest_pin_verify", { pin: "5678" })] }, { content: "Sorry." }],
      { pinPepper: "pep", stores: { guests } },
    );
    const call = await identifyCaller("+1guest", "+1owner", guests);
    for (let i = 0; i < MAX_PIN_FAILURES_PER_CALL; i++) await h.agent.handle(callEvent("0000", call, `g${i}`));
    expect(call.guestVerified).toBe(false);
    await h.agent.handle(callEvent("5678", call, "gx"));
    expect(call.guestVerified).toBe(false);
    expect(call.access).toBe("");
    const last = (await h.receipts.all()).filter((x) => x.tool === "guest_pin_verify").at(-1)!;
    expect(last.status).toBe("locked");
  });

  it("a guest revoked mid-call loses access on the next turn", async () => {
    const { guests, g } = await guestSetup();
    const h = makeHarness(
      [
        { content: "", toolCalls: [fakeToolCall("guest_pin_verify", { pin: "5678" })] },
        { content: "Verified." },
        { content: "I can't help further." },
      ],
      { pinPepper: "pep", stores: { guests } },
    );
    const call = await identifyCaller("+1guest", "+1owner", guests);
    await h.agent.handle(callEvent("5678", call, "g1"));
    expect(call.guestVerified).toBe(true);
    await guests.revoke(g.id);
    await h.agent.handle(callEvent("is Sid free?", call, "g2"));
    const system = h.model.requests.at(-1)!.messages[0]!.content;
    expect(system).not.toContain("free this weekend");
    expect(system).toContain("revoked");
    expect(call.access).toBe("");
  });

  it("the owner PIN also locks after the limit on a call", async () => {
    const call = newCallSession({ callerId: "+1owner", role: "owner" });
    const verify = makeOwnerPinVerifier("1234", "pep");
    for (let i = 0; i < MAX_PIN_FAILURES_PER_CALL; i++) expect((await verifyOwnerPinOnCall(call, "0000", verify)).ok).toBe(false);
    const res = await verifyOwnerPinOnCall(call, "1234", verify);
    expect(res.status).toBe("locked");
    expect(call.pinVerified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2.2 Twilio signature URL
// ---------------------------------------------------------------------------
describe("audit 2.2: Twilio signatures are checked against the public URL", () => {
  it("accepts a signature over PUBLIC_ORIGIN when request.url differs", async () => {
    const params = { CallSid: "CA1", From: "+1owner" };
    const sig = await twilioSign("tok", "https://jarvis.onesid.ca/voice", params);
    const internal = "https://jarvis-rebuild.sid.workers.dev/voice";
    expect(await verifyTwilioSignatureAny("tok", [internal], params, sig)).toBe(false); // the old behaviour
    const cands = twilioSignedUrlCandidates(internal, "https://jarvis.onesid.ca/");
    expect(cands[0]).toBe("https://jarvis.onesid.ca/voice");
    expect(await verifyTwilioSignatureAny("tok", cands, params, sig)).toBe(true);
  });

  it("the WebSocket handshake verifies over the wss:// URL with its query", async () => {
    const wsUrl = "wss://jarvis.onesid.ca/voice/ws?from=%2B1owner&callSid=CA1";
    const sig = await twilioSign("tok", wsUrl, {});
    const cands = twilioSignedUrlCandidates("https://internal.example/voice/ws?from=%2B1owner&callSid=CA1", "https://jarvis.onesid.ca", true);
    expect(cands).toContain(wsUrl);
    expect(await verifyTwilioSignatureAny("tok", cands, {}, sig)).toBe(true);
    // A tampered caller number in the URL fails.
    const tampered = twilioSignedUrlCandidates("https://x/voice/ws?from=%2B1other&callSid=CA1", "https://jarvis.onesid.ca", true);
    expect(await verifyTwilioSignatureAny("tok", tampered, {}, sig)).toBe(false);
    expect(await verifyTwilioSignatureAny(undefined, cands, {}, sig)).toBe(false); // fail closed
  });

  it("the TwiML turns on keypad detection", () => {
    expect(buildConnectTwiml("wss://x/voice/ws")).toContain('dtmfDetection="true"');
  });
});

// ---------------------------------------------------------------------------
// 2.3 Telegram length + media
// ---------------------------------------------------------------------------
describe("audit 2.3: Telegram long messages and attachments", () => {
  it("splits over 4096 into parts that rejoin exactly", () => {
    const text = Array.from({ length: 900 }, (_, i) => `line ${i} some words here`).join("\n");
    const parts = splitForTelegram(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    expect(parts.join("")).toBe(text);
    expect(splitForTelegram("short")).toEqual(["short"]);
  });

  it("never splits a surrogate pair on a hard cut", () => {
    const text = "a" + "😀".repeat(3000); // odd offset: a plain cut at 4096 would land mid-pair
    const parts = splitForTelegram(text);
    expect(parts.join("")).toBe(text);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
      const last = p.charCodeAt(p.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("sendText sends every part, and reports a mid-way failure honestly", async () => {
    const sent: string[] = [];
    let failOn = -1;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (sent.length === failOn) return new Response("too long", { status: 400 });
      sent.push(body.text);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const ch = new TelegramChannel("t", "1", fetchImpl);
    const long = "word ".repeat(2000); // 10,000 chars
    const ok = await ch.sendText(long);
    expect(ok.ok).toBe(true);
    expect(sent.join("")).toBe(long);
    sent.length = 0;
    failOn = 1;
    const bad = await ch.sendText(long);
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe("telegram_400");
    expect(bad.detail).toContain("part 2 of 3");
  });

  const env: Env = { TELEGRAM_WEBHOOK_SECRET: "s", OWNER_CHAT_ID: "42" };
  const chat = { id: 42, type: "private" };

  it("a photo's caption is the message text, and the photo is named as an attachment", () => {
    const d = verifyTelegramWebhook("s", { message: { message_id: 1, chat, caption: "what is this?", photo: [{}] } }, env);
    expect(d.update!.text).toBe("what is this?");
    expect(d.update!.attachments).toEqual(["photo"]);
    expect(eventTextFor(d.update!)).toContain("what is this?");
    expect(eventTextFor(d.update!)).toContain("cannot open attachments");
  });

  it("a voice note with no text still reaches Jarvis (never an empty message)", () => {
    const d = verifyTelegramWebhook("s", { message: { message_id: 2, chat, voice: { duration: 3 } } }, env);
    expect(d.update!.attachments).toEqual(["voice"]);
    expect(eventTextFor(d.update!)).toContain("voice");
  });

  it("a service update with no text or attachment is acknowledged, not processed", () => {
    const d = verifyTelegramWebhook("s", { message: { message_id: 3, chat, pinned_message: {} } }, env);
    expect(d.ok).toBe(true);
    expect(d.update).toBeUndefined();
  });

  it("plain text is untouched", () => {
    const d = verifyTelegramWebhook("s", { message: { message_id: 4, chat, text: "hi" } }, env);
    expect(eventTextFor(d.update!)).toBe("hi");
  });
});

// ---------------------------------------------------------------------------
// 3.2 ConversationRelay WebSocket loop
// ---------------------------------------------------------------------------
describe("audit 3.2: the voice relay drives the same brain as text", () => {
  function relayFor(h: ReturnType<typeof makeHarness>, opts: { from?: string; callSid?: string; ownerPhone?: string } = {}) {
    const out: RelayOutbound[] = [];
    const closed: string[] = [];
    let n = 0;
    const relay = new VoiceRelay({
      agent: h.agent,
      guests: h.guests,
      receipts: h.receipts,
      clock: h.clock,
      ownerPhoneE164: opts.ownerPhone ?? "+1owner",
      ownerPinVerifier: h.ownerPinVerifier,
      pinPepper: "pep",
      signedFrom: opts.from ?? "+1owner",
      signedCallSid: opts.callSid ?? "CA1",
      send: (m) => out.push(m),
      close: (_c, r) => closed.push(r),
      newEventId: () => `v${++n}`,
    });
    const send = (m: object) => relay.onMessage(JSON.stringify(m));
    const setup = (from = opts.from ?? "+1owner") => send({ type: "setup", callSid: opts.callSid ?? "CA1", from });
    return { relay, out, closed, send, setup };
  }

  it("an owner utterance is one voice-channel turn; the reply is spoken back", async () => {
    const h = makeHarness([{ content: "Hi Sid." }], { ownerPin: "1234", pinPepper: "pep" });
    const r = relayFor(h);
    await r.setup();
    await r.send({ type: "prompt", voicePrompt: "hello jarvis", lang: "en-US", last: true });
    expect(r.relay.session!.role).toBe("owner");
    expect(h.model.requests[0]!.messages[0]!.content).toContain("CHANNEL: voice");
    expect(r.out).toEqual([{ type: "text", token: "Hi Sid.", last: true }]);
    const convo = await h.conversation.all();
    expect(convo.some((m) => m.channel === "voice" && m.content === "hello jarvis")).toBe(true);
  });

  it("a setup that disagrees with the signed URL ends the call", async () => {
    const h = makeHarness([{ content: "never" }]);
    const r = relayFor(h);
    await r.setup("+1someoneelse");
    expect(r.out[0]!.type).toBe("end");
    expect(r.closed).toEqual(["setup mismatch"]);
    await r.send({ type: "prompt", voicePrompt: "hi", last: true });
    expect(h.model.requests).toHaveLength(0);
  });

  it("a prompt before setup is ignored and receipted", async () => {
    const h = makeHarness([{ content: "never" }]);
    const r = relayFor(h);
    await r.send({ type: "prompt", voicePrompt: "hi", last: true });
    expect(h.model.requests).toHaveLength(0);
    expect((await h.receipts.all()).some((x) => x.status === "refused")).toBe(true);
  });

  it("a model failure is spoken as a plain status, never a fake answer", async () => {
    const h = makeHarness([
      () => {
        throw new Error("boom");
      },
    ]);
    const r = relayFor(h);
    await r.setup();
    await r.send({ type: "prompt", voicePrompt: "hi", last: true });
    expect(r.out).toEqual([{ type: "text", token: MODEL_DOWN_LINE, last: true }]);
  });

  it("END TO END: spend → yes → pin_required → keypad PIN → confirmed and executed", async () => {
    const h = makeHarness([], { ownerPin: "1234", pinPepper: "pep" });
    const r = relayFor(h);
    const script: any[] = [
      { content: "", toolCalls: [fakeToolCall("spend_money", { amount: 9, currency: "CAD", description: "lunch" })] },
      { content: "Want me to spend nine dollars on lunch?" },
      async () => ({ content: "", toolCalls: [fakeToolCall("confirm_action", { pending_id: (await pendingIds(h))[0] })] }),
      { content: "I need your PIN first." },
      async () => ({ content: "", toolCalls: [fakeToolCall("confirm_action", { pending_id: (await pendingIds(h))[0] })] }),
      { content: "Done — well, spending isn't connected yet, so nothing was charged." },
    ];
    (h.model as any).turns.push(...script);
    await r.setup();
    await r.send({ type: "prompt", voicePrompt: "spend nine bucks on lunch", last: true });
    await r.send({ type: "prompt", voicePrompt: "yes", last: true });
    const [pendingId] = await pendingIds(h);
    expect((await h.pending.get(pendingId!))!.status).toBe("pending"); // not burned by pin_required
    for (const d of "1234") await r.send({ type: "dtmf", digit: d });
    expect(r.relay.session!.pinVerified).toBe(true);
    // The brain was told the keypad outcome — never the digits.
    const keypadTurn = h.model.requests.find((q) => q.messages.some((m) => m.content.startsWith("[keypad]")))!;
    expect(keypadTurn).toBeDefined();
    const all = await h.receipts.all();
    const final = all.filter((x) => x.tool === "spend_money").at(-1)!;
    expect(final.status).toBe("not_connected"); // the real tool ran (honestly unconnected)
    expect(all.map((x) => x.inputJson + x.resultJson).join("")).not.toContain("1234");
    expect(r.out.at(-1)).toMatchObject({ type: "text", last: true });
  });

  it("keypad: * clears, # submits early, wrong PIN counts toward the lock", async () => {
    const h = makeHarness([], { ownerPin: "1234", pinPepper: "pep" });
    const r = relayFor(h);
    await r.setup();
    for (const d of ["9", "9", "*", "1", "2", "3", "4"]) await r.send({ type: "dtmf", digit: d });
    expect(r.relay.session!.pinVerified).toBe(true);
    const h2 = makeHarness([], { ownerPin: "1234", pinPepper: "pep" });
    const r2 = relayFor(h2);
    await r2.setup();
    for (const d of ["1", "2", "#"]) await r2.send({ type: "dtmf", digit: d });
    expect(r2.relay.session!.pinVerified).toBe(false);
    expect(r2.relay.session!.pinFailures).toBe(1);
  });

  it("a guest keys their PIN on the keypad and only then gets their access", async () => {
    const h = makeHarness([{ content: "Hello, what's your PIN?" }], { pinPepper: "pep" });
    await h.guests.create({
      name: "Mom",
      phone: "+1guest",
      pinHash: await hashPin("5678", "pep"),
      access: "May ask whether Sid is free this weekend.",
      expiresAt: new Date(h.clock.nowMs() + HOUR).toISOString(),
    });
    const r = relayFor(h, { from: "+1guest" });
    await r.setup();
    await r.send({ type: "prompt", voicePrompt: "hi it's mom", last: true });
    expect(h.model.requests[0]!.messages[0]!.content).not.toContain("free this weekend");
    for (const d of "5678") await r.send({ type: "dtmf", digit: d });
    expect(r.relay.session!.guestVerified).toBe(true);
    expect(h.model.requests.at(-1)!.messages[0]!.content).toContain("free this weekend");
    expect(await h.conversation.all()).toHaveLength(0); // guest calls never enter Sid's memory
  });

  it("messages are processed in order and the session dies with the socket", async () => {
    const h = makeHarness([{ content: "one" }, { content: "two" }], { ownerPin: "1234", pinPepper: "pep" });
    const r = relayFor(h);
    const a = r.setup();
    const b = r.send({ type: "prompt", voicePrompt: "first", last: true });
    const c = r.send({ type: "prompt", voicePrompt: "second", last: true });
    await Promise.all([a, b, c]);
    expect(r.out.map((m) => (m as any).token)).toEqual(["one", "two"]);
    r.relay.session!.pinVerified = true;
    await r.relay.onClose();
    expect(r.relay.session).toBeUndefined();
    expect((await h.receipts.all()).some((x) => x.tool === "call_end")).toBe(true);
  });
});
