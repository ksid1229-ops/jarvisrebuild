/**
 * Academic-honesty guardrails.
 *
 * PRODUCT RULE, NOT A SETTING: this tool must never produce finished,
 * submit-ready answers. Both schools treat uncited AI writing as academic
 * dishonesty. The rule is enforced in three independent places so that no
 * single failure (a prompt the model ignores, a UI bug, a future refactor)
 * can let finished prose through:
 *
 *   1. The system prompt below states the rule.
 *   2. Output shape is constrained to bullets with evidence links.
 *   3. `enforceNotesOnly` post-checks the model's reply and truncates or
 *      rejects anything that looks like a drafted answer.
 *
 * There is no flag to disable any of this.
 */

export const HARD_RULE = `HARD RULE — NEVER BREAK THIS:
You are a study aid for a Grade 12 Ontario student. You must NOT write a finished,
submit-ready answer, paragraph, essay, or any prose the student could paste into a
worksheet. Producing that would be academic dishonesty and would harm the student.
Output ONLY short note-form bullet points that the student then writes up themselves,
in their own words. Never write more than 25 words in a single bullet. Never write
connected prose. Never write a topic sentence, an introduction, or a conclusion.
If asked to write the answer, refuse and give notes instead.`;

export const EVIDENCE_RULE = `EVIDENCE RULE:
Every bullet must be traceable to a source that was supplied to you in this prompt.
After each bullet, cite the source with [S1], [S2], … matching the numbered sources.
If a point is NOT supported by the supplied sources, you must still list it but prefix
it with "NOT IN SOURCE:" so it can be flagged. Never invent a quotation, statistic,
date, or citation. If the sources do not answer the question, say so plainly.`;

export interface EnforcementResult {
  text: string;
  violations: string[];
  modified: boolean;
}

const MAX_BULLET_WORDS = 30;
const PROSE_SENTENCE_THRESHOLD = 3;

/**
 * Post-check on model output. Strips anything that reads as a drafted answer.
 * This runs on every answer-notes response before it is shown or stored.
 */
export function enforceNotesOnly(raw: string): EnforcementResult {
  const violations: string[] = [];
  const lines = raw.split('\n');
  const kept: string[] = [];
  let modified = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push('');
      continue;
    }

    const isBullet = /^([-*•]|\d+[.)])\s+/.test(trimmed);
    const isHeading = /^#{1,6}\s|^[A-Z][^.!?]{0,80}:$/.test(trimmed);

    if (isHeading) {
      kept.push(line);
      continue;
    }

    if (!isBullet) {
      // A non-bullet line with multiple sentences is drafted prose.
      if (countSentences(trimmed) >= PROSE_SENTENCE_THRESHOLD || wordCount(trimmed) > 45) {
        violations.push(`Removed a block of drafted prose (${wordCount(trimmed)} words).`);
        modified = true;
        continue;
      }
      kept.push(line);
      continue;
    }

    const body = trimmed.replace(/^([-*•]|\d+[.)])\s+/, '');
    if (wordCount(body) > MAX_BULLET_WORDS) {
      const clipped = body.split(/\s+/).slice(0, MAX_BULLET_WORDS).join(' ');
      kept.push(line.replace(body, `${clipped}… [shortened: notes only]`));
      violations.push('Shortened an over-long bullet — notes must stay in note form.');
      modified = true;
      continue;
    }
    kept.push(line);
  }

  let text = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) {
    text = '_The model returned drafted prose instead of notes, so nothing is shown. Try again._';
    violations.push('Entire response was drafted prose and was rejected.');
    modified = true;
  }

  return { text, violations, modified };
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function countSentences(s: string): number {
  return (s.match(/[.!?](\s|$)/g) ?? []).length;
}

/**
 * Detect opinion / position questions, which need the student's stance first.
 * Notes for these are only generated after the student picks a side.
 */
export function isOpinionQuestion(question: string): boolean {
  const q = question.toLowerCase();
  const patterns = [
    /\bdo you (think|agree|believe)\b/,
    /\bin your opinion\b/,
    /\bwhat is your (view|opinion|position|stance)\b/,
    /\b(argue|defend|justify) (for|your|whether)\b/,
    /\btake a (side|position|stance)\b/,
    /\bshould\b.*\?/,
    /\bagree or disagree\b/,
    /\bto what extent\b/,
    /\bwhich (is better|do you prefer|would you choose)\b/,
    /\bis it (ethical|fair|justified|right)\b/,
  ];
  return patterns.some((re) => re.test(q));
}

/** Two-to-four stances offered before notes are produced for an opinion question. */
export function stanceOptions(question: string): string[] {
  const q = question.toLowerCase();
  if (/agree or disagree|do you agree/.test(q)) {
    return [
      'Agree',
      'Disagree',
      'Agree with reservations',
      'It depends — I will explain the conditions',
    ];
  }
  if (/to what extent/.test(q)) {
    return ['To a great extent', 'To a limited extent', 'Only in certain cases', 'Not at all'];
  }
  if (/\bshould\b/.test(q)) {
    return ['Yes, it should', 'No, it should not', 'Yes, but with conditions'];
  }
  return ['For', 'Against', 'Mixed / it depends'];
}

/** The rubric check may edit the student's own words — but not replace them. */
export const RUBRIC_RULE = `RUBRIC CHECK RULES:
You are reviewing work the student already wrote. You must:
 - keep the student's own wording and voice wherever possible
 - point out what the level-4 descriptor asks for that is missing
 - correct factual errors, stating the correction plainly
 - suggest edits as targeted before/after pairs on short spans, never as a rewritten whole
You must NOT rewrite the response for them, write new paragraphs, or produce a
"here is an improved version" block. Suggestions only, anchored to their text.`;
