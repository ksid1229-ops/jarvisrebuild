import type { Provenance } from "../types.js";
import { twilioSignedUrlCandidates, verifyTwilioSignatureAny } from "../voice/twilio-signature.js";

/**
 * Twilio inbound SMS/MMS webhook: Sid's second text channel (2026-09-26:
 * "both" — Telegram and SMS, one brain).
 *
 * FAIL CLOSED, in order:
 *  - bad/missing Twilio signature (or no TWILIO_AUTH_TOKEN) → 403, nothing runs;
 *  - OWNER_PHONE_E164 unset → 500, nobody is Sid;
 *  - a sender that is not Sid's number → acknowledged (so Twilio doesn't retry)
 *    and ignored: strangers never reach the brain by text.
 * Sid's number is a Twilio-verified fact (the request is signed), unlike a
 * phone call where caller ID alone never grants anything — there the keypad PIN
 * still guards the five actions, and here the YES/tap confirmation does.
 */

export interface AcceptedSms {
  from: string;
  text: string;
  messageSid: string;
  provenance: Provenance;
  /** Content types of MMS attachments. Jarvis cannot open them yet. */
  attachments?: string[];
}

export interface SmsDecision {
  status: number;
  reason: string;
  sms?: AcceptedSms;
}

export interface SmsWebhookEnv {
  TWILIO_AUTH_TOKEN?: string;
  PUBLIC_ORIGIN?: string;
  OWNER_PHONE_E164?: string;
}

export async function acceptSmsWebhook(
  params: Record<string, string>,
  signature: string | null,
  requestUrl: string,
  env: SmsWebhookEnv,
): Promise<SmsDecision> {
  const signed = await verifyTwilioSignatureAny(
    env.TWILIO_AUTH_TOKEN,
    twilioSignedUrlCandidates(requestUrl, env.PUBLIC_ORIGIN),
    params,
    signature,
  );
  if (!signed) return { status: 403, reason: "bad twilio signature" };
  const owner = env.OWNER_PHONE_E164?.trim();
  if (!owner) return { status: 500, reason: "OWNER_PHONE_E164 not configured" };
  const from = params.From ?? "";
  if (from !== owner) return { status: 200, reason: "not the owner; ignored" };

  const messageSid = params.MessageSid ?? params.SmsSid ?? "";
  if (messageSid === "") return { status: 400, reason: "no MessageSid" };
  const count = Number(params.NumMedia ?? "0");
  const attachments: string[] = [];
  for (let i = 0; Number.isInteger(count) && i < count; i++) {
    attachments.push(params[`MediaContentType${i}`] || "unknown type");
  }
  return {
    status: 200,
    reason: "accepted",
    sms: {
      from,
      text: params.Body ?? "",
      messageSid,
      provenance: {
        channel: "text",
        isOwner: true,
        isForwarded: false,
        isPrivate: true,
        sourceRef: `sms:${messageSid}`,
        sourceType: "conversation",
        medium: "sms",
      },
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
}

/** The text Jarvis receives for an SMS; MMS attachments are named, never pretended-read. */
export function smsEventText(sms: Pick<AcceptedSms, "text" | "attachments">): string {
  const kinds = sms.attachments ?? [];
  if (kinds.length === 0) return sms.text;
  const note = `[MMS attachment: ${kinds.join(", ")}. Jarvis cannot open attachments yet; only the text${
    sms.text.trim() === "" ? " (none)" : " above"
  } arrived.]`;
  return sms.text.trim() === "" ? note : `${sms.text}\n${note}`;
}

/** An empty TwiML reply: Twilio gets its answer at once; Jarvis replies via the REST API. */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
