import type { Tool, ToolResult } from "../jarvis/tool-types.js";
import { newId } from "../ids.js";
import { escapeXml, isE164 } from "./twilio-rest.js";
import { rememberOutbound, type PhoneServices } from "./phone.js";

const notConnected = (why: string): ToolResult => ({
  ok: false,
  status: "not_connected",
  message: `${why} Nothing was sent or dialed.`,
});

/** Fail-closed readiness check shared by the phone tools. */
export function phoneReady(phone: PhoneServices | undefined, needs: { owner?: boolean; origin?: boolean }): ToolResult | null {
  if (!phone) return notConnected("Phone (Twilio) is not wired in this build.");
  const gap = phone.rest.missing();
  if (gap) return notConnected(`Twilio is not configured (${gap} unset).`);
  if (needs.owner && !phone.ownerPhone) return notConnected("OWNER_PHONE_E164 is unset, so I don't know Sid's number.");
  if (needs.origin && !phone.publicOrigin) {
    return notConnected("PUBLIC_ORIGIN is unset, so Twilio has no address to fetch the call from.");
  }
  return null;
}

/**
 * call_place — Jarvis rings Sid (roadmap Phase 5). The same brain, memory and
 * tools as a call Sid places; the five actions still need his keypad PIN.
 *
 * Not one of the five confirmed actions: it can only ever dial Sid's own
 * number (there is no `to`), and asking him by text before phoning him would
 * defeat the point of a call. Voicemail: Jarvis hangs up without leaving a
 * message (anyone might hear a voicemail) and is told, so it can text instead.
 */
export const callPlace: Tool = {
  name: "call_place",
  description:
    "Phone Sid now (his own number only). Use it when a call is better than a text — it's urgent, or he " +
    "asked you to call. reason: why you're calling; you'll be reminded of it when he picks up so you can " +
    "open with it. If he doesn't answer or it goes to voicemail, you'll get a [call outcome] message and " +
    "can decide what to do (e.g. text him). This returns as soon as the phone starts ringing.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string" } },
    required: ["reason"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const reason = String(args.reason ?? "").trim();
    if (reason === "") return { ok: false, status: "refused", message: "reason is empty." };
    if (ctx.call) {
      return { ok: false, status: "refused", message: "You are already on a call with the caller; call_place would ring Sid's phone again." };
    }
    const phone = ctx.phone;
    const notReady = phoneReady(phone, { owner: true, origin: true });
    if (notReady) return notReady;
    const ref = newId("oc");
    const origin = phone!.publicOrigin!.replace(/\/+$/, "");
    await rememberOutbound(phone!.settings, ref, {
      purpose: "owner",
      to: phone!.ownerPhone!,
      text: reason,
      placedAt: ctx.clock.nowIso(),
    });
    const res = await phone!.rest.createCall({
      to: phone!.ownerPhone!,
      url: `${origin}/voice/outbound?ref=${encodeURIComponent(ref)}`,
      machineDetection: "Enable",
      statusCallback: `${origin}/voice/status?ref=${encodeURIComponent(ref)}`,
    });
    if (!res.ok) return { ok: false, status: res.status, message: `The call could not be placed: ${res.detail ?? res.status}` };
    return {
      ok: true,
      status: "ringing",
      message: "Sid's phone is ringing. Whether he answers is not known yet; you'll hear either way.",
      data: { ref, callSid: res.sids?.[0] ?? null },
    };
  },
};

/** TwiML for a one-way message call on Sid's behalf: the confirmed words, nothing added. */
export function oneWayMessageTwiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say></Response>`;
}

/** Shared by contact_on_behalf (runs only after Sid confirmed the exact args). */
export async function contactOnBehalfRun(
  args: Record<string, unknown>,
  ctx: Parameters<Tool["run"]>[1],
): Promise<ToolResult> {
  const method = args.method;
  const to = String(args.to ?? "").trim();
  const message = String(args.message ?? "");
  if (method !== "text" && method !== "call") {
    return { ok: false, status: "refused", message: "method must be 'text' or 'call'." };
  }
  if (!isE164(to)) {
    return { ok: false, status: "refused", message: `to must be a phone number in E.164 form (like +16135550123): ${to}` };
  }
  if (message.trim() === "") return { ok: false, status: "refused", message: "message is empty." };
  const phone = ctx.phone;

  if (method === "text") {
    const notReady = phoneReady(phone, {});
    if (notReady) return notReady;
    const res = await phone!.rest.sendSms(to, message);
    if (!res.ok) return { ok: false, status: res.status, message: `The text to ${to} was not sent: ${res.detail ?? res.status}` };
    return {
      ok: true,
      status: "sent",
      message: `Texted ${to} from Jarvis's Twilio number (not Sid's own phone). Twilio accepted it; delivery to their phone is not confirmed.`,
      data: { sids: res.sids ?? [], ...(res.detail ? { detail: res.detail } : {}) },
    };
  }

  const notReady = phoneReady(phone, { origin: true });
  if (notReady) return notReady;
  const ref = newId("oc");
  await rememberOutbound(phone!.settings, ref, { purpose: "contact", to, text: message, placedAt: ctx.clock.nowIso() });
  const origin = phone!.publicOrigin!.replace(/\/+$/, "");
  const res = await phone!.rest.createCall({
    to,
    twiml: oneWayMessageTwiml(message),
    // On voicemail, wait for the beep so the message isn't spoken over the greeting.
    machineDetection: "DetectMessageEnd",
    statusCallback: `${origin}/voice/status?ref=${encodeURIComponent(ref)}`,
  });
  if (!res.ok) return { ok: false, status: res.status, message: `The call to ${to} could not be placed: ${res.detail ?? res.status}` };
  return {
    ok: true,
    status: "ringing",
    message:
      `Calling ${to} from Jarvis's Twilio number. When answered, the confirmed message is spoken once — ` +
      "one-way, you cannot hear or answer their reply. You'll get a [call outcome] when the call ends.",
    data: { ref, callSid: res.sids?.[0] ?? null },
  };
}
