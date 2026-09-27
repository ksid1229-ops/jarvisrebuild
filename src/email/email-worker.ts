import type { Clock } from "../clock.js";
import type { Bucket } from "../plumbing/bucket.js";
import type { EmailsStore, StoredEmail } from "./email-repo.js";
import { parseEmail } from "./mime.js";

/**
 * Inbound email flow. Cloudflare Email Routing (school@onesid.ca, with Sid's
 * personal and school inboxes auto-forwarded to it) hands each message to the
 * Worker's email() handler. This module is the pure core of that handler so it
 * can be tested without Cloudflare:
 *
 *   raw bytes → parse (defensively, warnings never hidden) → archive the
 *   UNTOUCHED .eml to the ARCHIVE bucket → store the parsed row in D1.
 *
 * Waking the brain (queue or direct) is the caller's job — see wakeTextFor.
 * Nothing here fakes success: an archive failure is returned loudly while the
 * D1 row still lands (the .eml can be re-archived; the words must not be lost).
 */

export interface AcceptEmailDeps {
  emails: EmailsStore;
  bucket: Bucket | undefined;
  clock: Clock;
}

export interface AcceptedEmail {
  email: StoredEmail;
  /** The raw .eml is preserved under this R2 key, when archiving worked. */
  r2Key: string | null;
  /** Every non-fatal limitation (parser warnings, archive failure). Never hidden. */
  warnings: string[];
}

export async function acceptInboundEmail(
  deps: AcceptEmailDeps,
  input: { raw: string; envelopeFrom: string; envelopeTo: string },
): Promise<AcceptedEmail> {
  const parsed = parseEmail(input.raw);
  const warnings = [...parsed.warnings];
  const from = input.envelopeFrom.trim() || parsed.from;
  const to = input.envelopeTo.trim() || parsed.to;
  const receivedAt = deps.clock.nowIso();

  // Archive the raw bytes first: even if parsing fell short, the original survives.
  const day = receivedAt.slice(0, 10);
  const r2Key = `emails/${day}/${receivedAt.replace(/[^0-9]/g, "")}-${Math.abs(hash(input.raw)).toString(36)}.eml`;
  let archived: string | null = null;
  if (deps.bucket) {
    try {
      await deps.bucket.put(r2Key, input.raw);
      archived = r2Key;
    } catch (e) {
      warnings.push(`archiving the raw .eml to R2 failed (${(e as Error).message}); the parsed record was still stored`);
    }
  } else {
    warnings.push("no ARCHIVE bucket is bound; the raw .eml was not archived (the parsed record was stored)");
  }

  const email = await deps.emails.insert({
    fromAddr: from,
    toAddr: to,
    subject: parsed.subject,
    textBody: parsed.text,
    receivedAt,
    r2Key: archived,
  });
  return { email, r2Key: archived, warnings };
}

/**
 * The wake-up text handed to the brain for one email. The model decides what
 * the email means, whether to interrupt Sid and what to remember — code only
 * caps the excerpt (a system limit) and SAYS HOW MUCH was dropped.
 */
export const EMAIL_EXCERPT_CAP = 4000;

export function wakeTextFor(email: StoredEmail): string {
  const body = email.textBody;
  const dropped = Math.max(0, body.length - EMAIL_EXCERPT_CAP);
  const excerpt = dropped > 0 ? `${body.slice(0, EMAIL_EXCERPT_CAP)}\n…(first ${EMAIL_EXCERPT_CAP} of ${body.length} characters; ${dropped} not shown — use email_read for the full text)` : body;
  return [
    `New email arrived at ${email.toAddr}.`,
    `From: ${email.fromAddr}`,
    `Subject: ${email.subject || "(no subject)"}`,
    `Received: ${email.receivedAt}`,
    "",
    excerpt === "" ? "(the email had no readable text body — use email_read to check; the raw .eml is archived)" : excerpt,
  ]
    .join("\n")
    .trim();
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
