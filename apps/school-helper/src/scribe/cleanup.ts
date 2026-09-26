/**
 * Cleanup for scribe mode.
 *
 * Scribe mode is Sid's scribe accommodation: he speaks, and the app writes down
 * what he said. Cleanup may tidy delivery. It may not contribute content.
 *
 * Relationship to the answer-notes guardrails (see DECISIONS.md #18):
 * `enforceNotesOnly` is NOT applied here, and must not be. It exists to stop the
 * AI writing Sid's answers for him. Scribe output is already Sid's answer, in
 * his own words — passing it through a notes-only filter would mangle his work.
 * The protection here is different and stronger: a mechanical word-level diff
 * proves nothing was added, and Sid sees it before accepting.
 */

import { complete } from '../ai';
import type { ScribeAnswer } from '../common/types';
import { diffAnswer } from './diff';

export const CLEANUP_SYSTEM_PROMPT = `You are a scribe. A student with a scribe accommodation has spoken an answer aloud and it has been transcribed. Write down exactly what he said, tidied for reading.

YOU MAY:
- delete filler: "um", "uh", "er", "like", "you know", "I mean", "sort of"
- delete false starts and repeated words ("the the" -> "the")
- fix spelling, punctuation and capitalisation
- join his fragments into complete sentences using ONLY the words he already said
- reorder words within a sentence only where grammar requires it

YOU MAY NOT, UNDER ANY CIRCUMSTANCES:
- add an idea, fact, example, reason, statistic, date, name or definition
- add a transition, linking phrase or topic sentence he did not say
- add adjectives, adverbs or any word that carries meaning he did not say
- make his argument stronger, clearer or more complete than he made it
- expand an abbreviation into something he did not say
- finish an incomplete thought

If what he said is vague, incomplete or wrong, LEAVE IT VAGUE, INCOMPLETE OR WRONG. That is his work. It is not your job to improve it.

Every content word in your output must be a word he actually said. A reader will compare your output to the transcript word by word, and any word you add will be highlighted.

Reply with the cleaned text only. No preamble, no notes, no quotation marks.`;

export interface CleanupOptions {
  /** Injected in tests; defaults to the app's configured provider. */
  completeImpl?: typeof complete;
  signal?: AbortSignal;
}

export interface CleanupResult {
  answer: ScribeAnswer;
  /** True when the model added nothing meaningful. */
  clean: boolean;
  error?: string;
}

/**
 * Cleans one answer.
 *
 * The raw capture is never modified. If the provider fails, is not configured,
 * or returns something unusable, the answer comes back with `raw` intact and an
 * error recorded — the failure is visible, and Sid can still type or accept the
 * raw text.
 */
export async function cleanupAnswer(
  answer: ScribeAnswer,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const run = options.completeImpl ?? complete;
  const raw = answer.raw;

  if (!raw.trim()) {
    return {
      answer: { ...answer, cleanupError: 'nothing-to-clean' },
      clean: true,
      error: 'nothing-to-clean',
    };
  }

  let text: string;
  try {
    const response = await run({
      role: 'strong',
      feature: 'scribe-cleanup',
      messages: [
        { role: 'system', content: CLEANUP_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Question he was answering: ${answer.prompt || '(none given)'}\n\nTranscript of what he said:\n${raw}`,
        },
      ],
      // Low temperature: this is transcription, not composition.
      temperature: 0,
      signal: options.signal,
    });
    text = response.text?.trim() ?? '';
  } catch (error) {
    // The raw answer survives a cleanup failure. That is the whole point.
    return {
      answer: {
        ...answer,
        raw,
        cleaned: undefined,
        diff: undefined,
        cleanupError: (error as Error).message,
      },
      clean: false,
      error: (error as Error).message,
    };
  }

  if (!text) {
    return {
      answer: { ...answer, raw, cleanupError: 'empty-response' },
      clean: false,
      error: 'empty-response',
    };
  }

  const diff = diffAnswer(raw, text);
  return {
    answer: { ...answer, raw, cleaned: text, diff, cleanupError: undefined },
    clean: diff.clean,
  };
}

/** Exported so the UI can label the export without recomputing. */
export function acceptedText(answer: ScribeAnswer): string {
  return answer.accepted ?? answer.cleaned ?? answer.raw;
}
