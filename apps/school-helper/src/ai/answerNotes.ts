import type { SourceRef } from '../common/types';
import { complete, type CompletionResult } from './provider';
import {
  EVIDENCE_RULE,
  HARD_RULE,
  enforceNotesOnly,
  isOpinionQuestion,
  stanceOptions,
} from './guardrails';

export interface AnswerNotesRequest {
  /** The worksheet or lesson questions, one per entry. */
  questions: string[];
  /** Only sources the lesson provides, or one the student named explicitly. */
  sources: LoadedSource[];
  courseCode: string;
  /** Chosen stance per question index, for opinion questions. */
  stances?: Record<number, string>;
  disclosureAccepted?: boolean;
}

export interface LoadedSource {
  ref: SourceRef;
  /** Extracted plain text. Empty when the source could not be read. */
  text: string;
  truncated?: boolean;
}

export interface AnswerNotesResult {
  markdown: string;
  violations: string[];
  /** Questions that need a stance before notes can be produced. */
  needsStance: { index: number; question: string; options: string[] }[];
  sourcesUsed: { n: number; title: string; url: string; chars: number }[];
  usage: Pick<
    CompletionResult,
    'promptTokens' | 'completionTokens' | 'estimatedCostUsd' | 'model' | 'providerLabel'
  >;
}

const MAX_CHARS_PER_SOURCE = 12_000;
const MAX_TOTAL_CHARS = 60_000;

/**
 * Produce answer NOTES — never answers.
 * Only the supplied sources are in scope; anything outside them gets flagged.
 */
export async function generateAnswerNotes(req: AnswerNotesRequest): Promise<AnswerNotesResult> {
  // 1. Opinion questions need a stance from the student first.
  const needsStance = req.questions
    .map((q, index) => ({ index, question: q, options: stanceOptions(q) }))
    .filter((x) => isOpinionQuestion(x.question) && !req.stances?.[x.index]);

  if (needsStance.length) {
    return {
      markdown: '',
      violations: [],
      needsStance,
      sourcesUsed: [],
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        model: '',
        providerLabel: '',
      },
    };
  }

  // 2. Build the source block. Nothing else may be used.
  const usable = req.sources.filter((s) => s.text.trim().length > 0);
  if (!usable.length) {
    return {
      markdown:
        '_No readable sources were attached to this lesson. Open the lesson, or name a source yourself, then try again — notes are only generated from sources you supply._',
      violations: ['No sources available; refused to answer from general knowledge.'],
      needsStance: [],
      sourcesUsed: [],
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        model: '',
        providerLabel: '',
      },
    };
  }

  let budget = MAX_TOTAL_CHARS;
  const sourcesUsed: AnswerNotesResult['sourcesUsed'] = [];
  const blocks: string[] = [];
  usable.forEach((s, i) => {
    const n = i + 1;
    const slice = s.text.slice(0, Math.min(MAX_CHARS_PER_SOURCE, Math.max(0, budget)));
    budget -= slice.length;
    if (!slice) return;
    sourcesUsed.push({ n, title: s.ref.title, url: s.ref.url, chars: slice.length });
    blocks.push(`[S${n}] ${s.ref.title}\nURL: ${s.ref.url}\n---\n${slice}\n---`);
  });

  const questionBlock = req.questions
    .map((q, i) => {
      const stance = req.stances?.[i];
      return `Q${i + 1}. ${q}${stance ? `\n   (The student's chosen position: ${stance}. Find support for THIS position in the sources; also note the strongest counter-point.)` : ''}`;
    })
    .join('\n');

  const system = [
    HARD_RULE,
    EVIDENCE_RULE,
    `CONTEXT: ${req.courseCode}, Grade 12 Ontario.`,
    `OUTPUT FORMAT — follow exactly:
### Q1 <restate the question in under 12 words>
- <note, max 25 words> [S1]
- <note, max 25 words> [S2]
- NOT IN SOURCE: <anything you had to bring from outside the sources> 
**Gaps:** <what the sources do not cover for this question, or "none">

Repeat for each question. No other prose anywhere in the reply.`,
  ].join('\n\n');

  const user = `SOURCES (the ONLY material you may use):\n\n${blocks.join('\n\n')}\n\nQUESTIONS:\n${questionBlock}`;

  const result = await complete({
    role: 'strong',
    feature: 'answer-notes',
    temperature: 0.1,
    disclosureAccepted: req.disclosureAccepted,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  // 3. Post-check: strip anything that came back as drafted prose.
  const enforced = enforceNotesOnly(result.text);
  const flagged = collectFlags(enforced.text);

  const footer = [
    '',
    '---',
    '**Sources used**',
    ...sourcesUsed.map((s) => `- [S${s.n}] [${s.title}](${s.url})`),
    '',
    '> These are notes, not answers. Write the response in your own words, and cite the sources above.',
  ].join('\n');

  return {
    markdown: `${enforced.text}\n${footer}`,
    violations: [...enforced.violations, ...flagged],
    needsStance: [],
    sourcesUsed,
    usage: {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      model: result.model,
      providerLabel: result.providerLabel,
    },
  };
}

/** Surface every "NOT IN SOURCE" line as an explicit warning. */
export function collectFlags(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /NOT IN SOURCE:\s*(.+)/i.exec(line);
    if (m) out.push(`Unsupported claim flagged: ${m[1].trim()}`);
  }
  return out;
}

/** Cited bullets, parsed back out for the UI's per-claim evidence links. */
export function parseNotes(
  markdown: string,
  sources: { n: number; title: string; url: string }[],
): { question: string; bullets: { point: string; sourceUrl?: string; inSource: boolean }[] }[] {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const out: {
    question: string;
    bullets: { point: string; sourceUrl?: string; inSource: boolean }[];
  }[] = [];
  let current: (typeof out)[number] | null = null;

  for (const line of markdown.split('\n')) {
    const h = /^###\s+(.*)$/.exec(line.trim());
    if (h) {
      current = { question: h[1].trim(), bullets: [] };
      out.push(current);
      continue;
    }
    const b = /^[-*•]\s+(.*)$/.exec(line.trim());
    if (b && current) {
      const raw = b[1];
      const notInSource = /^NOT IN SOURCE:/i.test(raw);
      const cite = /\[S(\d+)\]/.exec(raw);
      current.bullets.push({
        point: raw
          .replace(/\[S\d+\]/g, '')
          .replace(/^NOT IN SOURCE:\s*/i, '')
          .trim(),
        sourceUrl: cite ? byN.get(Number(cite[1]))?.url : undefined,
        inSource: !notInSource && !!cite,
      });
    }
  }
  return out;
}
