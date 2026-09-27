import { describe, expect, it } from "vitest";
import { makeHarness, callEvent, newCallSession } from "./helpers.js";
import { fakeToolCall } from "../src/model/fake-model.js";
import { identifyCaller } from "../src/voice/caller-id.js";
import { GuestsRepo } from "../src/voice/guests-repo.js";
import { buildGuestPrompt } from "../src/voice/guest-prompt.js";
import { buildConnectTwiml } from "../src/voice/twiml.js";
import { verifyTwilioSignature } from "../src/voice/twilio-signature.js";
import { makeOwnerPinVerifier, hashPin } from "../src/voice/pin.js";
import { FixedClock } from "../src/clock.js";
import { InMemoryPcHeartbeatRepo } from "../src/pc/pc-tools.js";
import { InMemoryPcJobsRepo } from "../src/pc/pc-jobs-repo.js";

describe("Phase 5: calling", () => {
  it("same brain on a call: an owner voice turn uses the same tools and memory as text", async () => {
    const h = makeHarness([
      { content: "", toolCalls: [fakeToolCall("memory_save", { text: "Sid prefers evening calls", kind: "durable", confidence: "inferred" })] },
      { content: "Got it." },
    ]);
    const call = newCallSession({ callerId: "+1owner", role: "owner" });
    await h.agent.handle(callEvent("remember I prefer evening calls", call, "c1"));
    // The fact landed in the SAME store text uses.
    expect((await h.facts.activeFacts()).some((f) => f.text.includes("evening calls"))).toBe(true);
    // The call transcript is in the shared history (memory review / history_search see it).
    expect((await h.conversation.all()).some((m) => m.channel === "voice")).toBe(true);
  });

  it("the system prompt says CHANNEL: voice and gives spoken guidance", async () => {
    const h = makeHarness([{ content: "ok" }]);
    const call = newCallSession({ callerId: "+1owner", role: "owner" });
    await h.agent.handle(callEvent("hi", call, "c1"));
    const system = h.model.requests[0]!.messages[0]!.content;
    expect(system).toContain("CHANNEL: voice");
    expect(system.toLowerCase()).toContain("phone call");
  });

  it("a sensitive action on a call REFUSES without a verified PIN (caller id alone is not enough)", async () => {
    const h = makeHarness([{ content: "x" }], { ownerPin: "1234" });
    const call = newCallSession({ callerId: "+1owner", role: "owner" });
    const ctx = h.ctxFor(callEvent("spend money", call, "c1"));
    await h.dispatcher.dispatch("spend_money", { amount: 9, currency: "CAD", description: "x" }, ctx);
    const pendingId = [...(h.pending as any).actions.keys()][0] as string;
    // Confirm in a later turn but WITHOUT a verified PIN.
    const ctx2 = h.ctxFor(callEvent("yes do it", call, "c2"));
    const res = await h.dispatcher.executeConfirmed(pendingId, ctx2);
    expect(res.status).toBe("pin_required");
  });

  it("with a correct PIN the action proceeds (the purchase is honestly queued on the PC)", async () => {
    const clock = new FixedClock();
    const h = makeHarness([{ content: "x" }], {
      ownerPin: "1234",
      stores: { pcJobs: new InMemoryPcJobsRepo(), pcHeartbeat: new InMemoryPcHeartbeatRepo(clock) },
    });
    const call = newCallSession({ callerId: "+1owner", role: "owner" });
    // Verify PIN via the tool (spoken/keyed digits).
    const pinCtx = h.ctxFor(callEvent("pin 1234", call, "c1"));
    const pinRes = await h.dispatcher.dispatch("pin_verify", { pin: "1234" }, pinCtx);
    expect(pinRes.ok).toBe(true);
    expect(call.pinVerified).toBe(true);

    const ctx = h.ctxFor(callEvent("spend money", call, "c2"));
    await h.dispatcher.dispatch("spend_money", { url: "https://shop.example/pay", amount: 9, currency: "CAD", description: "x" }, ctx);
    const pendingId = [...(h.pending as any).actions.keys()][0] as string;
    const ctx3 = h.ctxFor(callEvent("confirm", call, "c3"));
    const res = await h.dispatcher.executeConfirmed(pendingId, ctx3);
    expect(res.status).toBe("queued_on_pc");
    expect((await h.pcJobs!.all())).toHaveLength(1);
  });

  it("a wrong PIN does not verify, and a missing PIN config fails closed", async () => {
    const verify = makeOwnerPinVerifier("1234", "pep");
    expect(await verify("1234")).toBe(true);
    expect(await verify("0000")).toBe(false);
    const noConfig = makeOwnerPinVerifier(undefined, "pep");
    expect(await noConfig("1234")).toBe(false); // fail closed
    const malformed = makeOwnerPinVerifier("12", "pep");
    expect(await malformed("12")).toBe(false);
  });

  it("caller id classifies owner, guest and unknown", async () => {
    const clock = new FixedClock();
    const guests = new GuestsRepo(clock);
    // seed a guest, expiring in the future
    (async () => {})();
    const g = await guests.create({
      name: "Mom",
      phone: "+1guest",
      pinHash: "h",
      access: "can ask when Sid is free",
      expiresAt: new Date(clock.nowMs() + 3_600_000).toISOString(),
    });
    expect((await identifyCaller("+1owner", "+1owner", guests)).role).toBe("owner");
    expect((await identifyCaller("+1guest", "+1owner", guests)).role).toBe("guest");
    expect((await identifyCaller("+1stranger", "+1owner", guests)).role).toBe("unknown");
    // Fail closed: with no configured owner phone, nobody is the owner.
    expect((await identifyCaller("+1owner", undefined, guests)).role).toBe("unknown");
    void g;
  });

  it("a guest call gets a minimal prompt with NO owner profile, memory or tools", async () => {
    const h = makeHarness([{ content: "Sid is not available to share that." }]);
    // Seed owner memory that must NOT leak.
    await h.facts.save({ text: "Sid's alarm code is 4821", kind: "durable", confidence: "stated", sourceType: "conversation", sourceRef: "x", expiresAt: null, pinned: true });
    const guestCall = newCallSession({ callerId: "+1guest", role: "guest", access: "May ask whether Sid is free this weekend." });
    const res = await h.agent.handle(callEvent("what's Sid's alarm code?", guestCall, "gc1"));
    const system = h.model.requests[0]!.messages[0]!.content;
    expect(system).not.toContain("4821");
    expect(system).toContain("GUEST");
    expect(system).toContain("May ask whether Sid is free this weekend.");
    // No tools were offered to the guest.
    expect(h.model.requests[0]!.tools).toHaveLength(0);
    // Guest transcript is NOT written into Sid's shared conversation memory.
    expect(await h.conversation.all()).toHaveLength(0);
    expect(res.reply).toContain("not available");
  });

  it("builds Connect TwiML pointing at the DO websocket", () => {
    const twiml = buildConnectTwiml("wss://jarvis.example/ws?call=1&x=2");
    expect(twiml).toContain("<Connect>");
    expect(twiml).toContain("ConversationRelay");
    expect(twiml).toContain("wss://jarvis.example/ws?call=1&amp;x=2");
  });

  it("verifies a Twilio signature and fails closed with no auth token", async () => {
    const url = "https://jarvis.example/voice";
    const params = { CallSid: "CA123", From: "+1owner" };
    // Compute a valid signature with a known token, then verify it.
    const token = "test-token";
    // Build the same string the verifier builds, sign it, and check round-trip.
    let data = url;
    for (const k of Object.keys(params).sort()) data += k + (params as any)[k];
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

    expect(await verifyTwilioSignature(token, url, params, b64)).toBe(true);
    expect(await verifyTwilioSignature(token, url, params, "wrong")).toBe(false);
    expect(await verifyTwilioSignature(undefined, url, params, b64)).toBe(false); // fail closed
  });

  it("hashPin is not reversible plaintext", async () => {
    const hash = await hashPin("1234", "pep");
    expect(hash).not.toContain("1234");
    expect(hash).toHaveLength(64);
  });
});
