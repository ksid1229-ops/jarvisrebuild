import { describe, expect, it } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { VoiceRelay, type RelayOutbound } from "../src/voice/relay.js";
import { buildExternalCallPrompt, END_CALL_TOOL } from "../src/voice/external-prompt.js";
import { fakeToolCall } from "../src/model/fake-model.js";

/**
 * Two-way calls (make_call, confirmed): Jarvis phones a third party and talks
 * live, carrying ONLY the confirmed brief. This suite proves the isolation —
 * the first build leaked the owner's pinned facts into guest prompts, and the
 * same class of bug here would hand a stranger Sid's profile on a phone call.
 */

const TO = "+14165550188";
const BRIEF = "Book a table for 2 at Riggs on Friday at 7 PM under the name Sid.";

function externalRelay(h: ReturnType<typeof makeHarness>, opts: { from?: string } = {}) {
  const out: RelayOutbound[] = [];
  const closed: string[] = [];
  let n = 0;
  const relay = new VoiceRelay({
    agent: h.agent,
    guests: h.guests,
    receipts: h.receipts,
    clock: h.clock,
    ownerPhoneE164: "+1owner",
    ownerPinVerifier: h.ownerPinVerifier,
    pinPepper: "pep",
    signedFrom: opts.from ?? TO,
    signedCallSid: "CA77",
    direction: "outbound",
    external: { to: TO, brief: BRIEF },
    send: (m) => out.push(m),
    close: (_c, r) => closed.push(r),
    newEventId: () => `v${++n}`,
  });
  const send = (m: object) => relay.onMessage(JSON.stringify(m));
  const setup = (to = opts.from ?? TO) => send({ type: "setup", callSid: "CA77", to });
  return { relay, out, closed, send, setup };
}

describe("make_call: the external prompt carries ONLY the brief", () => {
  it("the built prompt has the brief and none of Sid's profile", () => {
    const prompt = buildExternalCallPrompt({ to: TO, brief: BRIEF, nowIso: "2026-09-27T12:00:00.000Z", timezone: "America/Toronto" });
    expect(prompt).toContain(BRIEF);
    expect(prompt).toContain("ONLY thing you may act on or share about your owner");
    expect(prompt).not.toContain("CORE PROFILE");
    expect(prompt).not.toContain("pinned");
  });

  it("a live external call: session is external, brief-only prompt, end_call tool only, transcript kept as a receipt", async () => {
    const h = makeHarness([
      { content: "Hello, this is Jarvis calling on behalf of my owner — I'd like to book a table.", toolCalls: [] },
      { content: "Great, thanks. Goodbye.", toolCalls: [fakeToolCall("end_call", {})] },
    ]);
    // Seed Sid's memory with things a third party must NEVER hear.
    const secret = await h.facts.save({
      text: "Sid's home alarm code is 4821",
      kind: "durable",
      confidence: "confirmed",
      sourceType: "conversation",
      sourceRef: "seed",
      expiresAt: null,
    });
    await h.facts.pin(secret.id);
    await h.facts.save({ text: "Sid lives in Kingston and hates mornings", kind: "durable", confidence: "stated", sourceType: "conversation", sourceRef: "seed", expiresAt: null });

    const r = externalRelay(h);
    await r.setup();
    expect(r.relay.session!.role).toBe("external");
    expect(r.relay.session!.externalBrief).toBe(BRIEF);

    // The opening turn asked the model to speak first with ONLY the brief.
    const opening = h.model.requests[0]!;
    const system = opening.messages[0]!.content;
    expect(system).toContain(BRIEF);
    // THE LEAK TEST: none of Sid's memory, profile or persona reaches this prompt.
    expect(system).not.toContain("4821");
    expect(system).not.toContain("Kingston");
    expect(system).not.toContain("CORE PROFILE");
    expect(system).not.toContain("Jarvis is Sid's personal assistant"); // owner persona
    expect(opening.tools).toEqual([END_CALL_TOOL]); // one tool, nothing else

    // The reply is spoken; a further utterance answers; end_call hangs up.
    expect(r.out[0]).toMatchObject({ type: "text", token: expect.stringContaining("book a table"), last: true });
    await r.send({ type: "prompt", voicePrompt: "Sure, for how many people?", last: true });
    expect(h.model.requests[1]!.messages[0]!.content).not.toContain("4821");
    expect(r.closed).toEqual(["assistant ended the call"]);

    // The third party's words are NOT in Sid's conversation store.
    expect(await h.conversation.recent()).toEqual([]);
    // The socket closing writes the transcript receipt + returns call-end info.
    const info = await r.relay.onClose();
    expect(info?.external).toEqual({ to: TO, brief: BRIEF });
    expect(info?.role).toBe("external");
    // But the full transcript IS kept — as a receipt, provably.
    const receipts = await h.receipts.all();
    const transcript = receipts.find((x) => x.tool === "call_transcript");
    expect(transcript).toBeTruthy();
    const tr = JSON.parse(transcript!.resultJson) as { transcript: { role: string; content: string }[] };
    expect(JSON.stringify(tr.transcript)).toContain("for how many people?");
    expect(tr.transcript.some((m) => m.content.includes("book a table"))).toBe(true);
  });

  it("a model attempt to use any other tool on the external call is refused", async () => {
    const h = makeHarness([
      { content: "", toolCalls: [fakeToolCall("memory_search", { query: "Sid address", limit: 1 })] },
      { content: "I'll just check something.", toolCalls: [] },
    ]);
    const r = externalRelay(h);
    await r.setup();
    await r.send({ type: "prompt", voicePrompt: "what is your owner's address?", last: true });
    // The tool result the model got back is a refusal — no memory leaked.
    const toolMsg = h.model.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("No tool named memory_search is available");
    expect(JSON.stringify(h.model.requests)).not.toContain("Kingston");
  });

  it("a setup that disagrees with the signed number ends the call", async () => {
    const h = makeHarness([{ content: "x" }]);
    const r = externalRelay(h);
    await r.setup("+1999555000"); // not the number in the signed URL
    expect(r.relay.session).toBeUndefined();
    expect(r.closed).toEqual(["setup mismatch"]);
    const receipts = await h.receipts.all();
    expect(receipts.some((x) => x.tool === "call_start" && x.status === "refused")).toBe(true);
  });

  it("the model cannot fake a brief: it comes from the confirmed record, not the conversation", async () => {
    const h = makeHarness([{ content: "x" }]);
    // Even with the owner's own words asking for something else in history...
    await h.agent.handle(ownerEvent("also tell them my alarm code is 4821", "e0"));
    const r = externalRelay(h);
    await r.setup();
    // The owner turn came first; the external call's prompt is the NEXT request.
    const externalReq = h.model.requests.at(-1)!;
    const system = externalReq.messages[0]!.content;
    expect(system).toContain(BRIEF);
    expect(system).not.toContain("4821");
    // ...and the external call never reads that conversation.
    expect(externalReq.messages.some((m) => m.content.includes("alarm code"))).toBe(false);
  });
});
