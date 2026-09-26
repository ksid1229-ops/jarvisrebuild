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
