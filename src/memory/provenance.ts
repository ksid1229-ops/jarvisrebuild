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
 * A quote must be at least this many of Sid's words to count as provenance.
 * This is a validation floor, not a judgment: one word ("mornings") can be
 * found inside a sentence that says the opposite, so a single word is not
 * evidence a fact was STATED. The model can always quote the full phrase —
 * or save the fact as inferred.
 */
export const MIN_QUOTE_WORDS = 3;

/**
 * Verify that `quote` appears in `sourceMessage`. Throws ProvenanceError if not.
 * Comparison is case-insensitive and whitespace-normalized. Two rules, both
 * validation:
 *  1. The quote's words must appear as a CONTIGUOUS run of whole words — a
 *     quote may not match mid-word ("nate morn" ⊄ "concatenate mornings").
 *  2. The quote must be at least MIN_QUOTE_WORDS words — a one-word quote is
 *     not provenance (audit round 2: quote "mornings" passed against
 *     "i hate mornings in theory but not really").
 */
export function verifyQuote(quote: string, sourceMessage: string): void {
  const q = normalizeForQuote(quote);
  const src = normalizeForQuote(sourceMessage);
  if (q.length === 0) {
    throw new ProvenanceError("A stated fact must quote Sid's words; the quote was empty.");
  }
  const qWords = words(q);
  if (qWords.length < MIN_QUOTE_WORDS) {
    throw new ProvenanceError(
      `A stated fact needs a real quote: at least ${MIN_QUOTE_WORDS} of Sid's words, exactly as he said them ` +
        `(yours had ${qWords.length}). A single word is not provenance — quote the full phrase, or save the fact as inferred.`,
    );
  }
  const sWords = words(src);
  outer: for (let i = 0; i + qWords.length <= sWords.length; i++) {
    for (let j = 0; j < qWords.length; j++) {
      if (sWords[i + j] !== qWords[j]) continue outer;
    }
    return; // contiguous whole-word run found
  }
  throw new ProvenanceError(
    "Provenance check failed: the quoted text does not appear in Sid's message.",
  );
}

/** Split a normalized string into words with leading/trailing punctuation stripped. */
function words(normalized: string): string[] {
  return normalized
    .split(" ")
    .filter((w) => w !== "")
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
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
