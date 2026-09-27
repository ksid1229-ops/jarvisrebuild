import type { Clock } from "../clock.js";
import type { AgentResult, JarvisEvent } from "../jarvis/agent-core.js";
import type { ToolResult } from "../jarvis/tool-types.js";
import type { ReceiptsStore } from "../receipts/receipts-repo.js";
import type { CallSession } from "./call-session.js";
import { identifyCaller } from "./caller-id.js";
import { verifyGuestPinOnCall, verifyOwnerPinOnCall } from "./call-auth.js";
import type { GuestsStore } from "./guests-repo.js";
import type { OwnerPinVerifier } from "./pin.js";

/**
 * Twilio ConversationRelay WebSocket loop — the transport for phone calls.
 *
 * Twilio does speech-to-text and text-to-speech; this class only moves text.
 * Every caller utterance becomes ONE event for the SAME brain Telegram uses
 * (AgentCore.handle): same model, memory, tools and permissions. The only
 * difference on a call is the channel ("voice") and the per-call session that
 * carries caller role and this call's PIN state.
 *
 * Inbound messages (Twilio docs, "Getting and sending WebSocket messages"):
 *   setup {callSid, from, ...} · prompt {voicePrompt, last} · dtmf {digit}
 *   interrupt {utteranceUntilInterrupt} · error {description}
 * Outbound: text {token, last} · end {handoffData}
 *
 * The WebSocket URL (with `from` and `callSid` in it) is signed by Twilio and
 * verified in the Worker before the socket reaches here, so `signedFrom` is the
 * trusted caller number; the setup message must agree with it.
 *
 * Keypad: digits are collected on the session and checked in CODE against the
 * owner PIN (Sid) or the guest's PIN hash (guest) once four are entered — `*`
 * clears, `#` submits early. The digits are never logged or stored. The brain
 * is then told the outcome (never the digits) so it can carry on.
 */

export type RelayOutbound =
  | { type: "text"; token: string; last: boolean }
  | { type: "end"; handoffData?: string };

export interface RelayAgent {
  handle(event: JarvisEvent): Promise<AgentResult>;
}

export interface VoiceRelayDeps {
  agent: RelayAgent;
  guests: GuestsStore;
  receipts: ReceiptsStore;
  clock: Clock;
  ownerPhoneE164: string | undefined;
  ownerPinVerifier: OwnerPinVerifier | undefined;
  pinPepper: string | undefined;
  /**
   * The other party's number from the Twilio-signed WebSocket URL: the caller
   * on an inbound call, the person dialed on an outbound one.
   */
  signedFrom: string;
  /** "outbound" when Jarvis placed the call (call_place). Default inbound. */
  direction?: "inbound" | "outbound";
  /**
   * Outbound only: why Jarvis placed the call, from its record. null = the
   * record was not found (said so to the brain, never invented).
   */
  outboundReason?: string | null;
  /** CallSid from the Twilio-signed WebSocket URL. */
  signedCallSid: string;
  send(msg: RelayOutbound): void;
  close(code: number, reason: string): void;
  newEventId(): string;
}

/** Spoken when the model cannot be reached — a plain status, never a fake answer. */
export const MODEL_DOWN_LINE = "Sorry, I couldn't reach my model just now, so I can't answer that. Nothing was done.";

export class VoiceRelay {
  session: CallSession | undefined;
  private chain: Promise<void> = Promise.resolve();
  private turns = 0;
  private ended = false;

  constructor(private readonly d: VoiceRelayDeps) {}

  /**
   * Handle one raw WebSocket message. Messages are processed strictly in
   * order (a keypad digit never overtakes the utterance before it). Returns the
   * promise for this message's processing, for callers that want to await it.
   */
  onMessage(raw: string): Promise<void> {
    const next = this.chain.then(() => this.process(raw));
    this.chain = next.catch(async (e) => {
      await this.receipt("call_relay_error", { error: (e as Error).message }, "error", false);
    });
    return this.chain;
  }

  /** The socket closed: the call is over and its session (PIN state included) is discarded. */
  async onClose(): Promise<void> {
    await this.chain;
    if (this.session) {
      await this.receipt("call_end", { callSid: this.d.signedCallSid, role: this.session.role, turns: this.turns }, "ok", true);
    }
    this.session = undefined;
    this.ended = true;
  }

  private async process(raw: string): Promise<void> {
    if (this.ended) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      await this.receipt("call_relay_message", { note: "unparseable message" }, "error", false);
      return;
    }
    switch (msg.type) {
      case "setup":
        return this.onSetup(msg);
      case "prompt":
        return this.onPrompt(msg);
      case "dtmf":
        return this.onDigit(String(msg.digit ?? ""));
      case "interrupt":
        // Sid talked over the reply; the stored reply is longer than what he heard.
        await this.receipt(
          "call_interrupt",
          { heardChars: String(msg.utteranceUntilInterrupt ?? "").length, afterMs: msg.durationUntilInterruptMs ?? null },
          "ok",
          false,
        );
        return;
      case "error":
        await this.receipt("call_relay_error", { description: String(msg.description ?? "") }, "error", false);
        return;
      default:
        await this.receipt("call_relay_message", { note: `unknown message type ${String(msg.type)}` }, "error", false);
    }
  }

  private async onSetup(msg: Record<string, unknown>): Promise<void> {
    if (this.session) return; // a second setup changes nothing
    const outbound = this.d.direction === "outbound";
    // Inbound: the party is the caller (from). Outbound: the party is who we dialed (to).
    const party = String((outbound ? msg.to : msg.from) ?? "");
    const callSid = String(msg.callSid ?? "");
    // The signed URL is the trust anchor. A setup that disagrees with it ends the call.
    if (party !== this.d.signedFrom || (this.d.signedCallSid !== "" && callSid !== this.d.signedCallSid)) {
      await this.receipt("call_start", { callSid, note: "setup did not match the signed URL" }, "refused", false);
      this.endCall("setup mismatch");
      return;
    }
    this.session = await identifyCaller(this.d.signedFrom, this.d.ownerPhoneE164, this.d.guests);
    await this.receipt(
      "call_start",
      { callSid, role: this.session.role, guestId: this.session.guestId ?? null, direction: outbound ? "outbound" : "inbound" },
      "ok",
      true,
    );
    if (outbound) {
      // Jarvis rang; it speaks first, starting from why it called.
      const why =
        this.d.outboundReason === null || this.d.outboundReason === undefined
          ? "The record of why you called was not found — tell Sid that honestly rather than guess."
          : `Why you called: ${this.d.outboundReason}`;
      const who = this.session.role === "owner" ? "Sid" : "The person you dialed (not recognised as Sid)";
      await this.runTurn(`[outbound call] ${who} picked up the call you placed. ${why} Speak first.`);
    }
  }

  private async onPrompt(msg: Record<string, unknown>): Promise<void> {
    if (!this.session) {
      await this.receipt("call_relay_message", { note: "prompt before setup ignored" }, "refused", false);
      return;
    }
    // Partial prompts are off in our TwiML; if one arrives anyway, wait for the final.
    if (msg.last === false) return;
    const text = String(msg.voicePrompt ?? "");
    if (text.trim() === "") return;
    await this.runTurn(text);
  }

  private async onDigit(digit: string): Promise<void> {
    const call = this.session;
    if (!call) return;
    if (digit === "*") {
      call.dtmfBuffer = "";
      return;
    }
    if (digit === "#") {
      if (call.dtmfBuffer !== "") await this.submitKeypadPin();
      return;
    }
    if (!/^\d$/.test(digit)) return;
    call.dtmfBuffer += digit;
    if (call.dtmfBuffer.length >= 4) await this.submitKeypadPin();
  }

  private async submitKeypadPin(): Promise<void> {
    const call = this.session!;
    const pin = call.dtmfBuffer;
    call.dtmfBuffer = "";
    let result: ToolResult;
    let tool: string;
    if (call.role === "owner") {
      tool = "pin_verify";
      result = await verifyOwnerPinOnCall(call, pin, this.d.ownerPinVerifier);
    } else if (call.role === "guest" && call.guestId && !call.guestVerified) {
      tool = "guest_pin_verify";
      result = await verifyGuestPinOnCall(call, pin, { guests: this.d.guests, pepper: this.d.pinPepper, clock: this.d.clock });
    } else {
      tool = "keypad";
      result = { ok: false, status: "refused", message: "There is no PIN to enter on this call." };
    }
    // Receipt of the attempt — the digits themselves are never recorded.
    await this.receipt(tool, { via: "keypad", callSid: this.d.signedCallSid, role: call.role }, String(result.status), result.ok === true);
    // Tell the brain what happened on the keypad (the outcome, not the digits) so it can carry on.
    await this.runTurn(`[keypad] The caller entered a PIN on the keypad. Result: ${result.status}. ${result.message}`);
  }

  private async runTurn(text: string): Promise<void> {
    const call = this.session!;
    this.turns++;
    const eventId = this.d.newEventId();
    const event: JarvisEvent = {
      channel: "voice",
      trigger: "call",
      eventId,
      text,
      call,
      provenance: {
        channel: "voice",
        isOwner: call.role === "owner",
        isForwarded: false,
        isPrivate: true,
        sourceRef: `twilio:${this.d.signedCallSid || call.callId}:${eventId}`,
        sourceType: "call",
      },
    };
    const result = await this.d.agent.handle(event);
    if (result.error) {
      this.say(MODEL_DOWN_LINE);
      return;
    }
    if (result.reply.trim() !== "") this.say(result.reply);
  }

  private say(text: string): void {
    if (this.ended) return;
    this.d.send({ type: "text", token: text, last: true });
  }

  private endCall(reason: string): void {
    if (this.ended) return;
    this.d.send({ type: "end", handoffData: JSON.stringify({ reason }) });
    this.ended = true;
    this.d.close(1000, reason);
  }

  private async receipt(tool: string, input: unknown, status: string, performed: boolean): Promise<void> {
    await this.d.receipts.log({ tool, input, result: { status }, trigger: "call", performed, status });
  }
}
