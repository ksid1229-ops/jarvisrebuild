/**
 * Provenance check (Phase 2). When the model claims a fact is QUOTED from Sid
 * (confidence "stated"), code verifies the quoted text really appears in his
 * message. This is the ONLY check on a fact's content — everything about what
 * is worth remembering is the model's judgment. We are not reading Sid's words
 * to decide meaning; we are verifying a quote the model asserts is verbatim.
 */

export function normalizeForQuote(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceError";
  }
}

/**
 * Verify that `quote` appears in `sourceMessage`. Throws ProvenanceError if not.
 * Comparison is whitespace-normalized and case-insensitive; it is a substring
 * check, not a similarity score.
 */
export function verifyQuote(quote: string, sourceMessage: string): void {
  const q = normalizeForQuote(quote);
  const src = normalizeForQuote(sourceMessage);
  if (q.length === 0) {
    throw new ProvenanceError("A stated fact must quote Sid's words; the quote was empty.");
  }
  if (!src.includes(q)) {
    throw new ProvenanceError(
      "Provenance check failed: the quoted text does not appear in Sid's message.",
    );
  }
}

/** What a verified "stated" fact rests on. */
export interface StatedSource {
  /** messages.id of Sid's message that contains the quote. */
  messageId: string;
}

/** The slice of a tool context the resolver needs (kept narrow for testing). */
export interface StatedSourceContext {
  trigger: string;
  provenance: { isOwner: boolean; isForwarded: boolean };
  ownerMessageText: string;
  currentMessageId?: string;
  conversation: { get(id: string): Promise<import("../types.js").StoredMessage | undefined> };
}

/**
 * Resolve and verify the source of a "stated" fact. These are provenance facts
 * code knows and the model cannot see for itself — not judgments about meaning:
 *
 *  - With source_message_id (how memory reviews cite an earlier message): the
 *    message must exist, be Sid's (role user), not be a forwarded text, not be a
 *    summary, and contain the quote.
 *  - Without it, the source is the CURRENT message: the turn must be Sid's own
 *    live words (a text or a call from the owner, not forwarded), and the quote
 *    must appear in it.
 *
 * Throws ProvenanceError with a message the model can act on.
 */
export async function resolveStatedSource(
  quote: string,
  sourceMessageId: string | undefined,
  ctx: StatedSourceContext,
): Promise<StatedSource> {
  if (sourceMessageId !== undefined) {
    const m = await ctx.conversation.get(sourceMessageId);
    if (!m) throw new ProvenanceError(`source_message_id ${sourceMessageId} does not exist.`);
    if (m.isSummary) throw new ProvenanceError("A summary is not Sid's words; cite one of his messages.");
    if (m.role !== "user") throw new ProvenanceError("That message is yours, not Sid's; a stated fact must quote Sid.");
    if (m.forwarded) {
      throw new ProvenanceError("That message was forwarded, so it is not Sid's own words. Save it as inferred instead.");
    }
    verifyQuote(quote, m.content);
    return { messageId: m.id };
  }
  const live = ctx.trigger === "text" || ctx.trigger === "call";
  if (!live || !ctx.provenance.isOwner) {
    throw new ProvenanceError(
      "This turn is not a live message from Sid, so there is nothing to quote. Pass source_message_id " +
        "(from history_search or the review transcript) or save it as inferred.",
    );
  }
  if (ctx.provenance.isForwarded) {
    throw new ProvenanceError("The current message was forwarded, so it is not Sid's own words. Save it as inferred instead.");
  }
  verifyQuote(quote, ctx.ownerMessageText);
  if (!ctx.currentMessageId) throw new ProvenanceError("The current message was not stored; cannot link the fact to it.");
  return { messageId: ctx.currentMessageId };
}
