import type { SettingsStore } from "../settings/settings-repo.js";
import type { TwilioSendResult } from "./twilio-rest.js";

/**
 * Outbound phone services for tools: SMS and calls through Twilio, plus a tiny
 * record of each outbound call so the webhooks that fire later (answered,
 * voicemail, no answer) know why the call was placed.
 */
export interface PhoneOut {
  missing(): string | null;
  sendSms(to: string, body: string): Promise<TwilioSendResult>;
  createCall(input: {
    to: string;
    url?: string;
    twiml?: string;
    machineDetection?: "Enable" | "DetectMessageEnd";
    statusCallback?: string;
  }): Promise<TwilioSendResult>;
}

export type OutboundPurpose = "owner" | "contact" | "two_way";

export interface OutboundCallRecord {
  purpose: OutboundPurpose;
  to: string;
  /** owner: why Jarvis is calling Sid. contact: the exact message spoken. */
  text: string;
  placedAt: string;
}

export interface PhoneServices {
  rest: PhoneOut;
  /** Sid's number. call_place only ever dials this. */
  ownerPhone: string | undefined;
  /** The public origin Twilio calls back (PUBLIC_ORIGIN). */
  publicOrigin: string | undefined;
  settings: SettingsStore;
}

const KEY = (ref: string) => `outbound_call:${ref}`;

export async function rememberOutbound(settings: SettingsStore, ref: string, rec: OutboundCallRecord): Promise<void> {
  await settings.set(KEY(ref), JSON.stringify(rec));
}

/** The record for `ref`, or undefined when there is none (or it is unreadable — said so by the caller). */
export async function recallOutbound(settings: SettingsStore, ref: string): Promise<OutboundCallRecord | undefined> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(ref)) return undefined;
  const raw = await settings.get(KEY(ref));
  if (!raw) return undefined;
  try {
    const rec = JSON.parse(raw) as OutboundCallRecord;
    return typeof rec.to === "string" && typeof rec.text === "string" ? rec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What to tell Jarvis when an outbound call ends, or null when nothing needs
 * saying (Sid picked up and the conversation itself happened).
 */
export function describeCallOutcome(
  rec: OutboundCallRecord | undefined,
  ref: string,
  callStatus: string,
  answeredBy: string | undefined,
): string | null {
  const machine = answeredBy !== undefined && /^(machine|fax)/.test(answeredBy);
  const answered = callStatus === "completed";
  if (!rec) {
    return (
      `[call outcome] An outbound call (ref ${ref}) ended with status ${callStatus}` +
      `${answeredBy ? `, answered by ${answeredBy}` : ""}. Its record was not found, so why it was placed is unknown.`
    );
  }
  if (rec.purpose === "owner") {
    if (answered && !machine) return null;
    if (answered && machine) {
      return (
        `[call outcome] Your call to Sid reached his voicemail (${answeredBy}). You hung up without leaving a ` +
        `message. Why you called: ${rec.text}`
      );
    }
    return `[call outcome] Your call to Sid was not answered (status ${callStatus}). Why you called: ${rec.text}`;
  }
  if (rec.purpose === "two_way") {
    const who = `your two-way call to ${rec.to}`;
    if (answered && machine) {
      return (
        `[call outcome] ${who} was answered by voicemail (${answeredBy}). The call hung up without leaving anything — ` +
        `a conversation needs a person. Reason: ${rec.text} (use contact_on_behalf with method 'call' if you now want to leave a spoken message.)`
      );
    }
    if (answered) return null; // a person answered; the conversation itself happened on the relay
    return `[call outcome] ${who} did not go through (status ${callStatus}). Nothing was said. Reason: ${rec.text}`;
  }
  const who = `your call to ${rec.to} on Sid's behalf`;
  if (answered) {
    return (
      `[call outcome] ${who} was answered${machine ? ` by voicemail (${answeredBy}); the message played after the beep` : answeredBy ? ` (${answeredBy})` : ""}` +
      ` and the confirmed message was spoken. It was one-way: you could not hear any reply. Message: ${rec.text}`
    );
  }
  return `[call outcome] ${who} did not go through (status ${callStatus}). Nothing was said. Message: ${rec.text}`;
}
