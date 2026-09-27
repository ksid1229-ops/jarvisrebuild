import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";
import { contactOnBehalfRun, phoneReady } from "../channels/phone-tools.js";
import { newId } from "../ids.js";
import { isE164 } from "../channels/twilio-rest.js";
import { rememberOutbound } from "../channels/phone.js";
import { enqueueSpendJob } from "../pc/pc-tools.js";
import type { EmailAccount } from "../email/outbound.js";

/**
 * The FIVE confirmed actions (brief section 3). Each is marked confirmable, so
 * the gate stores it as pending and it runs only after Sid confirms.
 *
 * HONESTY, per action:
 *  - send_email: wired to Sid's real accounts (personal Gmail via the Gmail API,
 *    school Outlook via Microsoft Graph). not_connected when an account's
 *    secrets are unset. "sent" means the provider accepted it.
 *  - spend_money: wired to Sid's PC — a confirmed purchase queues a browser
 *    autofill job (saved card ending 2286) on his PC agent. When the PC is off
 *    it waits; nothing is ever reported as bought before it actually ran.
 *  - make_call: wired to Twilio ConversationRelay — a real two-way spoken call
 *    carrying ONLY the confirmed reason. Voicemail => hang up, honestly.
 *  - submit_schoolwork: still not connected (the School Helper is read-only by
 *    product rule; there is no submit surface to call).
 *  - contact_on_behalf: wired to Twilio (texts, one-way message calls).
 */

const notConnected = (what: string): ToolResult => ({
  ok: false,
  status: "not_connected",
  message: `${what} is not connected to a real provider yet. Nothing was sent or done.`,
});

export const spendMoney: Tool = {
  name: "spend_money",
  description:
    "Spend money on Sid's behalf (a purchase, a payment). One of the five actions that always needs Sid's " +
    "confirmation. When confirmed, a browser job opens the checkout on Sid's PC and completes it with his saved " +
    "card ending 2286 (autofill — Jarvis never holds the card number). url is the checkout page; amount, " +
    "currency (ISO 4217), description say what's being bought.",
  confirmable: true,
  parameters: {
    type: "object",
    properties: {
      confirmation_summary: { type: "string", description: "Optional: your one-line summary shown to Sid for confirmation." },
      url: { type: "string", description: "The checkout page to complete on Sid's PC." },
      amount: { type: "number" },
      currency: { type: "string" },
      description: { type: "string" },
    },
    required: ["url", "amount", "currency", "description"],
  },
  async run(args, ctx): Promise<ToolResult> {
    // Runs only after Sid confirmed these EXACT arguments.
    const url = String(args.url ?? "").trim();
    const amount = Number(args.amount);
    const currency = String(args.currency ?? "").trim().toUpperCase();
    const description = String(args.description ?? "").trim();
    if (url === "" || !/^https?:\/\//i.test(url)) {
      return { ok: false, status: "refused", message: "A confirmed purchase needs the checkout page URL (http/https). Nothing was queued." };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, status: "refused", message: "amount must be a positive number." };
    }
    if (currency === "" || description === "") {
      return { ok: false, status: "refused", message: "currency and description are required." };
    }
    if (!ctx.pc) {
      return notConnected("Spending money (Sid's PC surface is not wired — it needs the D1 binding)");
    }
    const job = await enqueueSpendJob(ctx.pc, { url, amount, currency, description });
    return {
      ok: true,
      status: "queued_on_pc",
      message:
        `Queued the purchase on Sid's PC (job ${job.id}): open ${url} and pay ${amount} ${currency} ` +
        `(${description}) with his saved card ending 2286. It runs when the PC agent picks it up — you'll get a ` +
        "[pc result] saying exactly what happened. Until then, nothing has been bought.",
      data: { job_id: job.id, url, amount, currency },
    };
  },
};

export const sendEmail: Tool = {
  name: "send_email",
  description:
    "Send an email from one of Sid's real accounts. One of the five actions that always needs his confirmation. " +
    "from: 'personal' is ksid1229@gmail.com (his Gmail); 'school' is sk7qq09@limestone.on.ca (his school Outlook). " +
    "You pick the account — school recipients (teachers, @limestone.on.ca) normally get 'school', everyone else " +
    "'personal' — unless Sid says otherwise. to, subject, body. When confirmed it really sends.",
  confirmable: true,
  parameters: {
    type: "object",
    properties: {
      confirmation_summary: { type: "string", description: "Optional: your one-line summary shown to Sid for confirmation." },
      from: { type: "string", enum: ["personal", "school"] },
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["from", "to", "subject", "body"],
  },
  async run(args, ctx): Promise<ToolResult> {
    // Runs only after Sid confirmed these EXACT arguments.
    const from = args.from;
    if (from !== "personal" && from !== "school") {
      return {
        ok: false,
        status: "refused",
        message: "from must be 'personal' (ksid1229@gmail.com) or 'school' (sk7qq09@limestone.on.ca). Code never picks the account for you.",
      };
    }
    if (!ctx.email?.sender) {
      return notConnected("Sending email (no email sender is wired — the Gmail/Graph secrets are unset)");
    }
    const res = await ctx.email.sender.send(from as EmailAccount, {
      to: String(args.to ?? "").trim(),
      subject: String(args.subject ?? ""),
      body: String(args.body ?? ""),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, message: `The email was not sent: ${res.detail ?? res.status}` };
    }
    return {
      ok: true,
      status: "sent",
      performed: true,
      message:
        `Email sent from ${res.fromAddress} to ${String(args.to)}. ${res.fromAddress?.includes("limestone") ? "Microsoft" : "Google"} ` +
        "accepted it; delivery to their inbox is the provider's business. A copy is in the account's Sent folder.",
      data: { from: res.fromAddress, to: String(args.to ?? "") },
    };
  },
};

export const makeCall: Tool = {
  name: "make_call",
  description:
    "Place a real two-way phone call to someone on Sid's behalf and talk to them yourself. One of the five actions " +
    "that always needs Sid's confirmation. to (E.164, like +16135550123); reason is what you're calling about — it " +
    "is the ONLY thing you'll carry on the call (the person hears nothing else about Sid), so write it as the " +
    "complete brief: e.g. 'book a table for 2 at Riggs on Friday 7 PM under Sid's name'. When they answer you " +
    "converse live; the full transcript is kept as proof and Sid can read it. If voicemail answers, the call hangs " +
    "up without leaving anything and you're told — use contact_on_behalf (method 'call') when you want to leave a " +
    "spoken message instead.",
  confirmable: true,
  parameters: {
    type: "object",
    properties: {
      confirmation_summary: { type: "string", description: "Optional: your one-line summary shown to Sid for confirmation." },
      to: { type: "string" },
      reason: { type: "string" },
    },
    required: ["to", "reason"],
  },
  async run(args, ctx): Promise<ToolResult> {
    // Runs only after Sid confirmed these EXACT arguments.
    const to = String(args.to ?? "").trim();
    const reason = String(args.reason ?? "").trim();
    if (reason === "") return { ok: false, status: "refused", message: "reason is empty — the call needs its brief." };
    if (!isE164(to)) {
      return { ok: false, status: "refused", message: `to must be a phone number in E.164 form (like +16135550123): ${to}` };
    }
    const notReady = phoneReady(ctx.phone, { origin: true });
    if (notReady) return notReady;
    const phone = ctx.phone!;
    const ref = newId("oc");
    await rememberOutbound(phone.settings, ref, { purpose: "two_way", to, text: reason, placedAt: ctx.clock.nowIso() });
    const origin = phone.publicOrigin!.replace(/\/+$/, "");
    const res = await phone.rest.createCall({
      to,
      url: `${origin}/voice/outbound?ref=${encodeURIComponent(ref)}`,
      machineDetection: "Enable",
      statusCallback: `${origin}/voice/status?ref=${encodeURIComponent(ref)}`,
    });
    if (!res.ok) return { ok: false, status: res.status, message: `The call could not be placed: ${res.detail ?? res.status}` };
    return {
      ok: true,
      status: "ringing",
      message:
        `Calling ${to} now. When a person answers you'll be speaking with them live, carrying only your confirmed ` +
        "reason — nothing else about Sid. The transcript is kept and you'll get a summary when the call ends. " +
        "If voicemail answers, the call hangs up without leaving anything and you'll be told.",
      data: { ref, callSid: res.sids?.[0] ?? null },
    };
  },
};

export const submitSchoolwork: Tool = {
  name: "submit_schoolwork",
  description:
    "Submit school work. One of the five actions that always needs Sid's confirmation. (The School Helper is " +
    "read-only by product rule: it observes D2L, it does not submit. This tool waits for a submit surface to exist.)",
  confirmable: true,
  parameters: {
    type: "object",
    properties: {
      confirmation_summary: { type: "string", description: "Optional: your one-line summary shown to Sid for confirmation." },
      course: { type: "string" },
      item: { type: "string" },
      note: { type: "string" },
    },
    required: ["course", "item"],
  },
  async run(): Promise<ToolResult> {
    return notConnected("Submitting school work");
  },
};

export const contactOnBehalf: Tool = {
  name: "contact_on_behalf",
  description:
    "Text or call someone on Sid's behalf. One of the five actions that always needs his confirmation. " +
    "method ('text' or 'call'), to (their number in E.164, like +16135550123), message. It comes from " +
    "Jarvis's Twilio number, NOT Sid's phone, so write the message so they know who it's from. A 'call' " +
    "speaks the message once and is one-way — you can't hear their reply. For a real two-way call use make_call.",
  confirmable: true,
  parameters: {
    type: "object",
    properties: {
      confirmation_summary: { type: "string", description: "Optional: your one-line summary shown to Sid for confirmation." },
      method: { type: "string", enum: ["text", "call"] },
      to: { type: "string" },
      message: { type: "string" },
    },
    required: ["method", "to", "message"],
  },
  run: contactOnBehalfRun,
};

export const actionTools: Tool[] = [spendMoney, sendEmail, makeCall, submitSchoolwork, contactOnBehalf];

/** Re-exported for tests: the ToolContext slice send_email needs. */
export type EmailCtx = ToolContext;
