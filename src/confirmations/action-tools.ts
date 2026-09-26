import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";

/**
 * The FIVE confirmed actions (brief section 3). Each is marked confirmable, so
 * the gate stores it as pending and it runs only after Sid confirms.
 *
 * HONESTY: none of these is wired to a real provider in this build. Each returns
 * status "not_connected" and logs it. They NEVER report "Executed" or
 * dispatched:true. When a provider is added, replace the body — the confirmation
 * gate and receipts around it do not change.
 */

const notConnected = (what: string): ToolResult => ({
  ok: false,
  status: "not_connected",
  message: `${what} is not connected to a real provider yet. Nothing was sent or done.`,
});

export const spendMoney: Tool = {
  name: "spend_money",
  description:
    "Spend money on Sid's behalf (a purchase, a payment). One of the five actions that always needs " +
    "Sid's confirmation. amount, currency (ISO 4217), description.",
  confirmable: true,
  parameters: {
    type: "object",
    properties: {
      confirmation_summary: { type: "string", description: "Optional: your one-line summary shown to Sid for confirmation." },
      amount: { type: "number" },
      currency: { type: "string" },
      description: { type: "string" },
    },
    required: ["amount", "currency", "description"],
  },
  async run(): Promise<ToolResult> {
    return notConnected("Spending money");
  },
};

export const sendEmail: Tool = {
  name: "send_email",
  description:
    "Send an email from Sid. One of the five actions that always needs his confirmation. to, subject, body.",
  confirmable: true,
  parameters: {
    type: "object",
    properties: {
      confirmation_summary: { type: "string", description: "Optional: your one-line summary shown to Sid for confirmation." },
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["to", "subject", "body"],
  },
  async run(): Promise<ToolResult> {
    return notConnected("Sending email");
  },
};

export const makeCall: Tool = {
  name: "make_call",
  description:
    "Place a phone call to someone. One of the five actions that always needs Sid's confirmation. " +
    "to (E.164 number), reason.",
  confirmable: true,
  parameters: {
    type: "object",
    properties: {
      confirmation_summary: { type: "string", description: "Optional: your one-line summary shown to Sid for confirmation." }, to: { type: "string" }, reason: { type: "string" } },
    required: ["to", "reason"],
  },
  async run(): Promise<ToolResult> {
    return notConnected("Making a call");
  },
};

export const submitSchoolwork: Tool = {
  name: "submit_schoolwork",
  description:
    "Submit school work. One of the five actions that always needs Sid's confirmation. (School is a " +
    "separate connected app; this is the placeholder its submit tool routes through.) course, item, note.",
  confirmable: true,
  parameters: {
    type: "object",
    properties: {
      confirmation_summary: { type: "string", description: "Optional: your one-line summary shown to Sid for confirmation." }, course: { type: "string" }, item: { type: "string" }, note: { type: "string" } },
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
    "method ('text' or 'call'), to, message.",
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
  async run(args): Promise<ToolResult> {
    if (args.method !== "text" && args.method !== "call") {
      return { ok: false, status: "refused", message: "method must be 'text' or 'call'." };
    }
    return notConnected("Contacting someone on Sid's behalf");
  },
};

export const actionTools: Tool[] = [spendMoney, sendEmail, makeCall, submitSchoolwork, contactOnBehalf];
