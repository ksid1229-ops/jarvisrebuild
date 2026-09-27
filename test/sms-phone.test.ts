import { describe, expect, it } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { fakeToolCall } from "../src/model/fake-model.js";
import { acceptSmsWebhook, smsEventText } from "../src/router/sms-webhook.js";
import { SMS_MAX_BODY, splitSms, TwilioRestClient } from "../src/channels/twilio-rest.js";
import { OwnerTextChannels } from "../src/channels/owner-text-channels.js";
import { describeCallOutcome, recallOutbound, type PhoneOut } from "../src/channels/phone.js";
import { oneWayMessageTwiml } from "../src/channels/phone-tools.js";
import { VoiceRelay, type RelayOutbound } from "../src/voice/relay.js";
import { buildSystemPrompt } from "../src/jarvis/system-prompt.js";

const TOKEN = "tw-token";
const OWNER = "+16135550100";
const URL_ = "https://jarvis.example/sms";

async function twilioSign(token: string, url: string, params: Record<string, string>): Promise<string> {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function formOf(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  new URLSearchParams(String(body)).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

const env = { TWILIO_AUTH_TOKEN: TOKEN, PUBLIC_ORIGIN: "https://jarvis.example", OWNER_PHONE_E164: OWNER };

/** A recording fake of the Twilio REST adapter (the real one is tested against a fake fetch below). */
class FakePhoneOut implements PhoneOut {
  sms: { to: string; body: string }[] = [];
  calls: Parameters<PhoneOut["createCall"]>[0][] = [];
  gap: string | null = null;
  missing() {
    return this.gap;
  }
  async sendSms(to: string, body: string) {
    this.sms.push({ to, body });
    return { ok: true, status: "ok", sids: ["SM1"] };
  }
  async createCall(input: Parameters<PhoneOut["createCall"]>[0]) {
    this.calls.push(input);
    return { ok: true, status: "ok", sids: ["CA9"] };
  }
}

describe("SMS inbound webhook", () => {
  const base = { From: OWNER, To: "+16135550999", Body: "hey jarvis", MessageSid: "SM123", NumMedia: "0" };

  it("accepts Sid's signed text as an owner turn on the sms medium", async () => {
    const d = await acceptSmsWebhook(base, await twilioSign(TOKEN, URL_, base), URL_, env);
    expect(d.status).toBe(200);
    expect(d.sms!.text).toBe("hey jarvis");
    expect(d.sms!.provenance).toMatchObject({ isOwner: true, medium: "sms", sourceRef: "sms:SM123", channel: "text" });
  });

  it("fails closed: bad signature, no auth token, no owner number", async () => {
    const sig = await twilioSign(TOKEN, URL_, base);
    expect((await acceptSmsWebhook({ ...base, Body: "tampered" }, sig, URL_, env)).status).toBe(403);
    expect((await acceptSmsWebhook(base, sig, URL_, { ...env, TWILIO_AUTH_TOKEN: "" })).status).toBe(403);
    expect((await acceptSmsWebhook(base, null, URL_, env)).status).toBe(403);
    const noOwner = await acceptSmsWebhook(base, sig, URL_, { ...env, OWNER_PHONE_E164: "" });
    expect(noOwner.status).toBe(500);
    expect(noOwner.sms).toBeUndefined();
  });

  it("a stranger's signed text is acknowledged and never reaches the brain", async () => {
    const p = { ...base, From: "+14165550123" };
    const d = await acceptSmsWebhook(p, await twilioSign(TOKEN, URL_, p), URL_, env);
    expect(d.status).toBe(200);
    expect(d.sms).toBeUndefined();
  });

  it("MMS attachments are named, never pretended-read", async () => {
    const p = { ...base, Body: "", NumMedia: "2", MediaContentType0: "image/jpeg", MediaContentType1: "video/mp4" };
    const d = await acceptSmsWebhook(p, await twilioSign(TOKEN, URL_, p), URL_, env);
    expect(d.sms!.attachments).toEqual(["image/jpeg", "video/mp4"]);
    const text = smsEventText(d.sms!);
    expect(text).toContain("image/jpeg, video/mp4");
    expect(text).toContain("cannot open");
  });
});

describe("Twilio REST adapter", () => {
  function recordingFetch(status = 201, fail?: number) {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const n = calls.length;
      if (fail !== undefined && n === fail) return new Response('{"message":"bad number"}', { status: 400 });
      return new Response(JSON.stringify({ sid: `SM${n}` }), { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const cfg = { accountSid: "AC1", authToken: "tok", fromE164: "+16135550999" };

  it("posts the form to the Messages API with basic auth", async () => {
    const { f, calls } = recordingFetch();
    const res = await new TwilioRestClient(cfg, f).sendSms(OWNER, "hello");
    expect(res).toMatchObject({ ok: true, sids: ["SM1"] });
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa("AC1:tok")}`);
    expect(formOf(calls[0]!.init.body)).toEqual({ To: OWNER, From: "+16135550999", Body: "hello" });
  });

  it("a long text goes out in order in ≤1600-char parts; a failure mid-way is reported with the count", async () => {
    const body = "word ".repeat(700); // 3500 chars
    const ok = recordingFetch();
    const res = await new TwilioRestClient(cfg, ok.f).sendSms(OWNER, body);
    expect(ok.calls).toHaveLength(3);
    const parts = ok.calls.map((c) => new URLSearchParams(String(c.init.body)).get("Body")!);
    expect(parts.join("")).toBe(body);
    expect(parts.every((p) => p.length <= SMS_MAX_BODY)).toBe(true);
    expect(res.sids).toEqual(["SM1", "SM2", "SM3"]);

    const bad = recordingFetch(201, 2);
    const r2 = await new TwilioRestClient(cfg, bad.f).sendSms(OWNER, body);
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe("twilio_400");
    expect(r2.detail).toContain("part 2 of 3; 1 delivered");
    expect(bad.calls).toHaveLength(2);
  });

  it("unconfigured → not_connected without any request; a non-E.164 number is refused", async () => {
    const { f, calls } = recordingFetch();
    const r = await new TwilioRestClient({ ...cfg, fromE164: undefined }, f).sendSms(OWNER, "x");
    expect(r.status).toBe("not_connected");
    expect(r.detail).toContain("TWILIO_FROM_E164");
    expect((await new TwilioRestClient(cfg, f).sendSms("613-555-0100", "x")).status).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  it("createCall sends Url/Twiml, machine detection and the status callback", async () => {
    const { f, calls } = recordingFetch();
    await new TwilioRestClient(cfg, f).createCall({
      to: OWNER,
      url: "https://jarvis.example/voice/outbound?ref=r1",
      machineDetection: "Enable",
      statusCallback: "https://jarvis.example/voice/status?ref=r1",
    });
    expect(calls[0]!.url).toContain("/Calls.json");
    const form = formOf(calls[0]!.init.body);
    expect(form).toMatchObject({ To: OWNER, Url: "https://jarvis.example/voice/outbound?ref=r1", MachineDetection: "Enable" });
    expect(form.StatusCallback).toBe("https://jarvis.example/voice/status?ref=r1");
  });

  it("splitSms never cuts an emoji in half (odd offset)", () => {
    const text = "a" + "😀".repeat(1000); // 1 + 2000 UTF-16 units, no spaces
    const parts = splitSms(text);
    expect(parts.join("")).toBe(text);
    for (const p of parts) {
      const last = p.charCodeAt(p.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});

describe("one brain, two text channels", () => {
  const sender = (log: string[], name: string, ok = true) => async (m: string) => {
    log.push(`${name}:${m}`);
    return ok ? { ok: true, status: "ok" } : { ok: false, status: "send_failed", detail: "down" };
  };

  it("an explicit via is used; an unconfigured medium is not_connected", async () => {
    const log: string[] = [];
    const ch = new OwnerTextChannels({ telegram: sender(log, "tg") }, async () => undefined);
    expect((await ch.sendText("a", "telegram")).via).toEqual(["telegram"]);
    const r = await ch.sendText("b", "sms");
    expect(r.status).toBe("not_connected");
    expect(log).toEqual(["tg:a"]);
  });

  it("no via → the medium Sid last used, and it says so", async () => {
    const log: string[] = [];
    const ch = new OwnerTextChannels({ telegram: sender(log, "tg"), sms: sender(log, "sms") }, async () => "sms");
    const r = await ch.sendText("hi");
    expect(log).toEqual(["sms:hi"]);
    expect(r.detail).toContain("last used");
  });

  it("no via and no history → every configured medium; a partial failure is reported", async () => {
    const log: string[] = [];
    const ch = new OwnerTextChannels({ telegram: sender(log, "tg"), sms: sender(log, "sms", false) }, async () => undefined);
    const r = await ch.sendText("hi");
    expect(log.sort()).toEqual(["sms:hi", "tg:hi"]);
    expect(r).toMatchObject({ ok: true, status: "partial", via: ["telegram"] });
    expect(r.detail).toContain("failed on sms");
  });

  it("send_text requires the model to choose via — never defaulted", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx = h.ctxFor(ownerEvent("x"));
    const r = await h.dispatcher.dispatch("send_text", { message: "hi" }, ctx);
    expect(r.status).toBe("refused");
    expect(h.ownerChannel.sent).toHaveLength(0);
    const ok = await h.dispatcher.dispatch("send_text", { message: "hi", via: "sms" }, ctx);
    expect(ok.message).toBe("sent on sms");
    expect(h.ownerChannel.sentVia).toEqual(["sms"]);
  });

  it("a confirmation request goes out on the medium Sid is using", async () => {
    const h = makeHarness([{ content: "x" }]);
    await h.dispatcher.dispatch(
      "spend_money",
      { amount: 5, currency: "CAD", description: "coffee" },
      h.ctxFor(ownerEvent("buy coffee", "e1", { provenance: { medium: "sms" } })),
    );
    expect(h.ownerChannel.sentVia).toEqual(["sms"]);
    expect(h.ownerChannel.sent[0]).toContain("Reply YES");
  });

  it("the prompt names the current medium and what's set up", async () => {
    const h = makeHarness([{ content: "ok" }], {
      textChannels: async () => ({ available: ["telegram", "sms"], lastUsed: "telegram" }),
    });
    await h.agent.handle(ownerEvent("hi", "e1", { provenance: { medium: "sms" } }));
    const sys = h.model.requests[0]!.messages[0]!.content as string;
    expect(sys).toContain("CHANNEL: text (sms)");
    expect(sys).toContain("TEXT CHANNELS: set up: telegram, sms. Sid last texted via: telegram.");
    expect(sys).toContain("no markdown");
    const plain = buildSystemPrompt({ nowIso: "2026-09-26T12:00:00.000Z", timezone: "America/Toronto", channel: "text", shadow: false, pinnedFacts: [] });
    expect(plain).not.toContain("TEXT CHANNELS");
  });
});

describe("contact_on_behalf (confirmed) and call_place", () => {
  const phoneFor = (rest: FakePhoneOut, extra: { ownerPhone?: string; publicOrigin?: string } = {}) => ({
    rest,
    ownerPhone: OWNER,
    publicOrigin: "https://jarvis.example/",
    ...extra,
  });

  async function confirmAndRun(h: ReturnType<typeof makeHarness>, args: Record<string, unknown>) {
    await h.dispatcher.dispatch("contact_on_behalf", args, h.ctxFor(ownerEvent("text mom", "e1")));
    const pendingId = [...(h.pending as any).actions.keys()][0] as string;
    return h.dispatcher.executeConfirmed(pendingId, h.ctxFor(ownerEvent("yes", "e2")));
  }

  it("nothing is sent before Sid confirms; after, the exact text goes to the number", async () => {
    const rest = new FakePhoneOut();
    const h = makeHarness([{ content: "x" }], { phone: phoneFor(rest) });
    await h.dispatcher.dispatch(
      "contact_on_behalf",
      { method: "text", to: "+14165550123", message: "Hi, it's Jarvis for Sid: he'll be late." },
      h.ctxFor(ownerEvent("text mom", "e1")),
    );
    expect(rest.sms).toHaveLength(0);
    const pendingId = [...(h.pending as any).actions.keys()][0] as string;
    const res = await h.dispatcher.executeConfirmed(pendingId, h.ctxFor(ownerEvent("yes", "e2")));
    expect(res.status).toBe("sent");
    expect(res.message).toContain("not Sid's own phone");
    expect(rest.sms).toEqual([{ to: "+14165550123", body: "Hi, it's Jarvis for Sid: he'll be late." }]);
  });

  it("unconfigured Twilio → not_connected, never 'sent'", async () => {
    const rest = new FakePhoneOut();
    rest.gap = "TWILIO_ACCOUNT_SID";
    const h = makeHarness([{ content: "x" }], { phone: phoneFor(rest) });
    const res = await confirmAndRun(h, { method: "text", to: "+14165550123", message: "hi" });
    expect(res.status).toBe("not_connected");
    expect(rest.sms).toHaveLength(0);
    const bare = makeHarness([{ content: "x" }]);
    expect((await confirmAndRun(bare, { method: "text", to: "+14165550123", message: "hi" })).status).toBe("not_connected");
  });

  it("a message call speaks exactly the confirmed words, waits for the voicemail beep, and reports back", async () => {
    const rest = new FakePhoneOut();
    const h = makeHarness([{ content: "x" }], { phone: phoneFor(rest) });
    const res = await confirmAndRun(h, { method: "call", to: "+14165550123", message: "Sid says <hi> & thanks" });
    expect(res.status).toBe("ringing");
    const call = rest.calls[0]!;
    expect(call.to).toBe("+14165550123");
    expect(call.twiml).toBe(oneWayMessageTwiml("Sid says <hi> & thanks"));
    expect(call.twiml).toContain("Sid says &lt;hi&gt; &amp; thanks");
    expect(call.machineDetection).toBe("DetectMessageEnd");
    const ref = (res.data as { ref: string }).ref;
    expect(call.statusCallback).toBe(`https://jarvis.example/voice/status?ref=${ref}`);
    expect(await recallOutbound(h.settings, ref)).toMatchObject({ purpose: "contact", to: "+14165550123", text: "Sid says <hi> & thanks" });
  });

  it("call_place rings only Sid's number and remembers why", async () => {
    const rest = new FakePhoneOut();
    const h = makeHarness([{ content: "x" }], { phone: phoneFor(rest) });
    const res = await h.dispatcher.dispatch("call_place", { reason: "your essay is due in an hour" }, h.ctxFor(ownerEvent("x")));
    expect(res.status).toBe("ringing");
    const call = rest.calls[0]!;
    expect(call.to).toBe(OWNER);
    const ref = (res.data as { ref: string }).ref;
    expect(call.url).toBe(`https://jarvis.example/voice/outbound?ref=${ref}`);
    expect(call.machineDetection).toBe("Enable");
    expect((await recallOutbound(h.settings, ref))!.text).toBe("your essay is due in an hour");
    // Not a confirmed action: no pending row, no confirmation text.
    expect((h.pending as any).actions.size).toBe(0);
  });

  it("call_place fails closed without PUBLIC_ORIGIN or Sid's number, and refuses mid-call", async () => {
    const rest = new FakePhoneOut();
    const noOrigin = makeHarness([{ content: "x" }], { phone: { rest, ownerPhone: OWNER } });
    expect((await noOrigin.dispatcher.dispatch("call_place", { reason: "r" }, noOrigin.ctxFor(ownerEvent("x")))).status).toBe("not_connected");
    const noOwner = makeHarness([{ content: "x" }], { phone: { rest, publicOrigin: "https://j" } });
    const r = await noOwner.dispatcher.dispatch("call_place", { reason: "r" }, noOwner.ctxFor(ownerEvent("x")));
    expect(r.status).toBe("not_connected");
    expect(r.message).toContain("OWNER_PHONE_E164");
    expect(rest.calls).toHaveLength(0);
  });

  it("make_call (confirmed) places a real two-way call carrying only the reason", async () => {
    const rest = new FakePhoneOut();
    const h = makeHarness([{ content: "x" }], { phone: phoneFor(rest) });
    await h.dispatcher.dispatch("make_call", { to: "+14165550123", reason: "book dentist: cleaning this week" }, h.ctxFor(ownerEvent("x", "e1")));
    expect(rest.calls).toHaveLength(0); // nothing before the confirmation
    const pendingId = [...(h.pending as any).actions.keys()][0] as string;
    const res = await h.dispatcher.executeConfirmed(pendingId, h.ctxFor(ownerEvent("yes", "e2")));
    expect(res.status).toBe("ringing");
    expect(res.message).toContain("only your confirmed reason");
    const call = rest.calls[0]!;
    expect(call.to).toBe("+14165550123");
    expect(call.machineDetection).toBe("Enable");
    const ref = (res.data as { ref: string }).ref;
    expect(call.url).toBe(`https://jarvis.example/voice/outbound?ref=${ref}`);
    expect(call.statusCallback).toBe(`https://jarvis.example/voice/status?ref=${ref}`);
    // The record says what this call is: a two-way call with that brief.
    expect(await recallOutbound(h.settings, ref)).toMatchObject({ purpose: "two_way", to: "+14165550123", text: "book dentist: cleaning this week" });
    // Voicemail on a two-way call hangs up without leaving anything.
    const rec = (await recallOutbound(h.settings, ref))!;
    const vm = describeCallOutcome(rec, ref, "completed", "machine_end")!;
    expect(vm).toContain("hung up without leaving anything");
    expect(vm).toContain("book dentist");
  });

  it("call outcomes: answered by Sid → nothing; voicemail/no-answer → told, with the reason", () => {
    const owner = { purpose: "owner" as const, to: OWNER, text: "essay due", placedAt: "t" };
    expect(describeCallOutcome(owner, "r", "completed", "human")).toBeNull();
    expect(describeCallOutcome(owner, "r", "completed", "unknown")).toBeNull();
    const vm = describeCallOutcome(owner, "r", "completed", "machine_start")!;
    expect(vm).toContain("voicemail");
    expect(vm).toContain("essay due");
    expect(describeCallOutcome(owner, "r", "no-answer", undefined)).toContain("not answered (status no-answer)");
    const contact = { purpose: "contact" as const, to: "+1416", text: "late", placedAt: "t" };
    expect(describeCallOutcome(contact, "r", "completed", "human")).toContain("one-way");
    expect(describeCallOutcome(contact, "r", "busy", undefined)).toContain("did not go through");
    expect(describeCallOutcome(undefined, "r9", "failed", undefined)).toContain("record was not found");
  });
});

describe("outbound call on the relay", () => {
  function relayFor(h: ReturnType<typeof makeHarness>, reason: string | null) {
    const out: RelayOutbound[] = [];
    const closed: string[] = [];
    let n = 0;
    const relay = new VoiceRelay({
      agent: h.agent,
      guests: h.guests,
      receipts: h.receipts,
      clock: h.clock,
      ownerPhoneE164: OWNER,
      ownerPinVerifier: h.ownerPinVerifier,
      pinPepper: "pep",
      signedFrom: OWNER,
      signedCallSid: "CA9",
      direction: "outbound",
      outboundReason: reason,
      send: (m) => out.push(m),
      close: (_c, r) => closed.push(r),
      newEventId: () => `v${++n}`,
    });
    return { relay, out, closed };
  }

  it("Sid picks up: Jarvis speaks first, opening from why it called", async () => {
    const h = makeHarness([{ content: "Hey Sid, your essay is due in an hour." }], { ownerPin: "1234", pinPepper: "pep" });
    const r = relayFor(h, "essay due in an hour");
    // Outbound: Twilio's setup has from = Jarvis's number, to = Sid.
    await r.relay.onMessage(JSON.stringify({ type: "setup", callSid: "CA9", from: "+16135550999", to: OWNER }));
    expect(r.relay.session!.role).toBe("owner");
    const user = h.model.requests[0]!.messages.at(-1)!.content as string;
    expect(user).toContain("[outbound call] Sid picked up");
    expect(user).toContain("essay due in an hour");
    expect(r.out).toContainEqual({ type: "text", token: "Hey Sid, your essay is due in an hour.", last: true });
  });

  it("a missing record is said plainly; a setup to the wrong number ends the call", async () => {
    const h = makeHarness([{ content: "Hi" }], { ownerPin: "1234", pinPepper: "pep" });
    const r = relayFor(h, null);
    await r.relay.onMessage(JSON.stringify({ type: "setup", callSid: "CA9", from: "+16135550999", to: OWNER }));
    expect(h.model.requests[0]!.messages.at(-1)!.content).toContain("was not found");

    const h2 = makeHarness([{ content: "x" }]);
    const r2 = relayFor(h2, "x");
    await r2.relay.onMessage(JSON.stringify({ type: "setup", callSid: "CA9", from: OWNER, to: "+16135550999" }));
    expect(r2.closed).toEqual(["setup mismatch"]);
    expect(h2.model.requests).toHaveLength(0);
  });
});
