import type { Tool, ToolResult } from "../jarvis/tool-types.js";
import type { EmailsStore } from "./email-repo.js";
import type { EmailOut } from "./outbound.js";

/** What the email tools get (repo for reading, sender for send_email). */
export interface EmailServices {
  repo: EmailsStore;
  /** Absent (no email secrets configured) => send_email returns not_connected. */
  sender?: EmailOut;
}

/**
 * Email reading tools. Inbound email arrives on its own (Cloudflare Email
 * Routing → Worker → queue → the brain is woken); these tools are how Jarvis
 * looks back at what arrived, on its own judgment. Every answer carries the
 * time each email arrived, so freshness is the model's to judge.
 *
 * email_list has NO cap on how many it returns (Sid, 2026-09-26: "Jarvis
 * should get as much as he needs"); the model chooses `since` and reads in
 * pages. email_read returns one email in full.
 */

const notConnected = (what: string): ToolResult => ({
  ok: false,
  status: "not_connected",
  message: `${what} No inbound email store is wired (email needs the D1 binding).`,
});

export const emailList: Tool = {
  name: "email_list",
  description:
    "List inbound emails that arrived at Jarvis's address (Sid's personal and school mail auto-forwards there), " +
    "newest first, with sender, subject, arrival time and the first line of the body. since (RFC 3339 UTC) bounds " +
    "the list from below — use it to page through history. There is no result cap; you choose how far back to look.",
  parameters: {
    type: "object",
    properties: {
      since: { type: "string", description: "Only emails received at or after this instant (RFC 3339 UTC, e.g. 2026-09-26T00:00:00Z)." },
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.email) return notConnected("email_list is not connected.");
    const sinceRaw = args.since === undefined ? undefined : String(args.since);
    let since: string | undefined;
    if (sinceRaw !== undefined && sinceRaw.trim() !== "") {
      const t = Date.parse(sinceRaw);
      if (Number.isNaN(t)) return { ok: false, status: "refused", message: `since is not a valid RFC 3339 timestamp: ${sinceRaw}` };
      since = sinceRaw;
    }
    const rows = await ctx.email.repo.recent(since);
    if (rows.length === 0) {
      return { ok: true, status: "ok", message: since ? `No emails arrived at or after ${since}.` : "No emails have arrived yet.", data: [] };
    }
    return {
      ok: true,
      status: "ok",
      message: `${rows.length} email(s), newest first. Use email_read(id) for any full body.`,
      data: rows.map((e) => ({
        id: e.id,
        from: e.fromAddr,
        subject: e.subject,
        received_at: e.receivedAt,
        preview: firstLine(e.textBody, 200),
        reviewed: e.reviewedAt !== null,
      })),
    };
  },
};

export const emailRead: Tool = {
  name: "email_read",
  description:
    "Read one inbound email in full (full text body, sender, subject, arrival time, and where the raw .eml is " +
    "archived). Get ids from email_list or from a [email] wake-up.",
  parameters: {
    type: "object",
    properties: { email_id: { type: "string", description: "The email id from email_list." } },
    required: ["email_id"],
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.email) return notConnected("email_read is not connected.");
    const id = String(args.email_id ?? "");
    const e = await ctx.email.repo.get(id);
    if (!e) return { ok: false, status: "not_found", message: `No email with id ${id}.` };
    return {
      ok: true,
      status: "ok",
      message: `Email ${e.id}: from ${e.fromAddr}, subject "${e.subject}", received ${e.receivedAt}. Full body:\n\n${e.textBody}`,
      data: {
        id: e.id,
        from: e.fromAddr,
        to: e.toAddr,
        subject: e.subject,
        received_at: e.receivedAt,
        text: e.textBody,
        raw_archived_at: e.r2Key,
      },
    };
  },
};

function firstLine(text: string, cap: number): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}
