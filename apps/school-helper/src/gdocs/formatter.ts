/**
 * Worksheet formatting fixer.
 *
 * Operates on the Google Docs API document model (not the canvas DOM), builds
 * an explicit list of edits, shows a preview, then applies them in one
 * batchUpdate. Every run stores an undo record.
 *
 * Rules implemented:
 *  1. Four blank lines between each question/answer block.
 *  2. The answer sits directly under its question.
 *  3. Lists and evidence each get their own line.
 *  4. Leftover horizontal answer lines and ____ underscores are removed.
 *  5. Evidence appears as links only, never as bare URLs.
 */

export interface DocParagraph {
  /** startIndex of the paragraph in the document body. */
  start: number;
  end: number;
  text: string;
  /** Named style, e.g. NORMAL_TEXT, HEADING_2. */
  style?: string;
  bullet?: boolean;
  /** Links already present, keyed by the text they cover. */
  links: { text: string; url: string }[];
  /** True when the paragraph is only a horizontal rule / underscores. */
  isAnswerLine?: boolean;
}

export interface DocModel {
  documentId: string;
  title: string;
  revisionId?: string;
  paragraphs: DocParagraph[];
}

export type FixKind =
  | 'spacing'
  | 'answer-position'
  | 'split-list'
  | 'remove-rule'
  | 'remove-underscores'
  | 'linkify-evidence';

export interface PlannedFix {
  kind: FixKind;
  label: string;
  /** Paragraph indices this affects, for highlighting in the preview. */
  paragraphs: number[];
  before: string;
  after: string;
}

export interface FormatPlan {
  documentId: string;
  title: string;
  revisionId?: string;
  fixes: PlannedFix[];
  /** Docs API requests, ordered back-to-front so indices stay valid. */
  requests: unknown[];
  /** Full original text, kept so undo can restore exactly. */
  snapshot: string;
}

const QUESTION_RE =
  /^\s*(?:(?:Q(?:uestion)?\s*)?(\d{1,2})\s*[.):\]]|\(\d{1,2}\)|[a-h]\s*[.)])\s+\S/i;
const ANSWER_RE = /^\s*(?:A(?:nswer)?\s*[:.]|Ans\s*[:.])\s*/i;
const RULE_RE = /^[\s_\-–—=.·•]{4,}$/;
const UNDERSCORE_RUN_RE = /_{3,}/g;
const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:])/g;
const INLINE_LIST_RE = /(?:^|\s)(?:[-•*]|\(?[ivx]+\)|\(?[a-d]\))\s+/g;

export function isQuestion(text: string): boolean {
  return QUESTION_RE.test(text.trim());
}

export function isAnswerLabel(text: string): boolean {
  return ANSWER_RE.test(text.trim());
}

export function isRuleLine(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && RULE_RE.test(t);
}

/**
 * Plan every fix for a document. Pure function over the parsed model, so it is
 * fully unit-testable without touching Google.
 */
export function planFormatting(doc: DocModel): FormatPlan {
  const fixes: PlannedFix[] = [];
  const paras = doc.paragraphs;

  // 1. Horizontal answer lines and underscore runs.
  paras.forEach((p, i) => {
    if (isRuleLine(p.text)) {
      fixes.push({
        kind: 'remove-rule',
        label: 'Remove leftover answer line',
        paragraphs: [i],
        before: p.text,
        after: '',
      });
      return;
    }
    if (UNDERSCORE_RUN_RE.test(p.text)) {
      UNDERSCORE_RUN_RE.lastIndex = 0;
      const cleaned = p.text
        .replace(UNDERSCORE_RUN_RE, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trimEnd();
      fixes.push({
        kind: 'remove-underscores',
        label: 'Strip ____ fill-in blanks',
        paragraphs: [i],
        before: p.text,
        after: cleaned,
      });
    }
    UNDERSCORE_RUN_RE.lastIndex = 0;
  });

  // 2. Inline lists and evidence that should be on their own lines.
  paras.forEach((p, i) => {
    if (isRuleLine(p.text)) return;
    const markers = p.text.match(INLINE_LIST_RE);
    if (markers && markers.length >= 2 && p.text.length > 80 && !p.bullet) {
      const split = p.text
        .replace(INLINE_LIST_RE, (m, off) => (off === 0 ? m : `\n${m.trim()} `))
        .trim();
      if (split !== p.text) {
        fixes.push({
          kind: 'split-list',
          label: 'Put each list item on its own line',
          paragraphs: [i],
          before: p.text,
          after: split,
        });
      }
    }
    const urls = p.text.match(URL_RE);
    if (urls && !isRuleLine(p.text)) {
      const bare = urls.filter((u) => !p.links.some((l) => l.url === u && l.text !== u));
      if (bare.length) {
        fixes.push({
          kind: 'linkify-evidence',
          label: `Turn ${bare.length} bare URL${bare.length > 1 ? 's' : ''} into ${bare.length > 1 ? 'links' : 'a link'}`,
          paragraphs: [i],
          before: p.text,
          after: p.text,
        });
      }
    }
  });

  // 3. Question/answer blocking: answer directly under its question,
  //    four blank lines before the next question.
  const blocks = detectBlocks(paras);
  for (const block of blocks) {
    const gapParas = paras.slice(block.answerEnd + 1, block.nextQuestion ?? paras.length);
    const blankCount = gapParas.filter((p) => !p.text.trim()).length;
    const nonBlank = gapParas.filter((p) => p.text.trim()).length;

    if (block.nextQuestion != null && blankCount !== 4 && nonBlank === 0) {
      fixes.push({
        kind: 'spacing',
        label: `Set 4 blank lines after Q${block.label}`,
        paragraphs: [block.answerEnd, block.nextQuestion],
        before: `${blankCount} blank line${blankCount === 1 ? '' : 's'}`,
        after: '4 blank lines',
      });
    }

    const between = paras.slice(block.questionEnd + 1, block.answerStart);
    if (between.length && between.every((p) => !p.text.trim())) {
      fixes.push({
        kind: 'answer-position',
        label: `Move the answer directly under Q${block.label}`,
        paragraphs: [block.questionEnd, block.answerStart],
        before: `${between.length} blank line${between.length === 1 ? '' : 's'} between question and answer`,
        after: 'answer immediately below the question',
      });
    }
  }

  return {
    documentId: doc.documentId,
    title: doc.title,
    revisionId: doc.revisionId,
    fixes,
    requests: buildRequests(doc, fixes),
    snapshot: paras.map((p) => p.text).join('\n'),
  };
}

export interface QaBlock {
  label: string;
  questionStart: number;
  questionEnd: number;
  answerStart: number;
  answerEnd: number;
  nextQuestion: number | null;
}

/** Group paragraphs into question → answer blocks. */
export function detectBlocks(paras: DocParagraph[]): QaBlock[] {
  const questionIdx = paras.map((p, i) => (isQuestion(p.text) ? i : -1)).filter((i) => i >= 0);
  const blocks: QaBlock[] = [];

  questionIdx.forEach((qStart, n) => {
    const nextQ = questionIdx[n + 1] ?? null;
    const limit = nextQ ?? paras.length;

    let qEnd = qStart;
    for (let i = qStart + 1; i < limit; i++) {
      if (!paras[i].text.trim()) break;
      if (isAnswerLabel(paras[i].text)) break;
      qEnd = i;
    }

    let aStart = -1;
    for (let i = qEnd + 1; i < limit; i++) {
      if (!paras[i].text.trim()) continue;
      aStart = i;
      break;
    }
    if (aStart === -1) aStart = qEnd + 1;

    let aEnd = aStart;
    for (let i = aStart; i < limit; i++) {
      if (paras[i].text.trim()) aEnd = i;
    }

    const m = QUESTION_RE.exec(paras[qStart].text.trim());
    blocks.push({
      label: m?.[1] ?? String(n + 1),
      questionStart: qStart,
      questionEnd: qEnd,
      answerStart: aStart,
      answerEnd: aEnd,
      nextQuestion: nextQ,
    });
  });

  return blocks;
}

/**
 * Turn the plan into Docs API requests.
 * Applied back-to-front (descending start index) so earlier edits do not
 * invalidate the indices of later ones.
 */
export function buildRequests(doc: DocModel, fixes: PlannedFix[]): unknown[] {
  const requests: { index: number; req: unknown }[] = [];
  const paras = doc.paragraphs;

  for (const fix of fixes) {
    const i = fix.paragraphs[0];
    const p = paras[i];
    if (!p) continue;

    switch (fix.kind) {
      case 'remove-rule':
        requests.push({
          index: p.start,
          req: { deleteContentRange: { range: { startIndex: p.start, endIndex: p.end } } },
        });
        break;

      case 'remove-underscores':
      case 'split-list':
        requests.push({
          index: p.start,
          req: {
            deleteContentRange: {
              range: { startIndex: p.start, endIndex: Math.max(p.start + 1, p.end - 1) },
            },
          },
        });
        requests.push({
          index: p.start + 0.5,
          req: { insertText: { location: { index: p.start }, text: fix.after } },
        });
        break;

      case 'linkify-evidence': {
        const urls = [...p.text.matchAll(URL_RE)];
        for (const m of urls) {
          const offset = m.index ?? 0;
          requests.push({
            index: p.start + offset,
            req: {
              updateTextStyle: {
                range: { startIndex: p.start + offset, endIndex: p.start + offset + m[0].length },
                textStyle: {
                  link: { url: m[0] },
                  underline: true,
                  foregroundColor: { color: { rgbColor: { blue: 0.8 } } },
                },
                fields: 'link,underline,foregroundColor',
              },
            },
          });
        }
        break;
      }

      case 'spacing': {
        const [answerEnd, nextQuestion] = fix.paragraphs;
        const from = paras[answerEnd];
        const to = paras[nextQuestion];
        if (!from || !to) break;
        // Replace whatever gap exists with exactly four newlines.
        if (to.start > from.end) {
          requests.push({
            index: from.end,
            req: { deleteContentRange: { range: { startIndex: from.end, endIndex: to.start } } },
          });
        }
        requests.push({
          index: from.end + 0.5,
          req: { insertText: { location: { index: from.end }, text: '\n\n\n\n' } },
        });
        break;
      }

      case 'answer-position': {
        const [questionEnd, answerStart] = fix.paragraphs;
        const from = paras[questionEnd];
        const to = paras[answerStart];
        if (!from || !to || to.start <= from.end) break;
        requests.push({
          index: from.end,
          req: { deleteContentRange: { range: { startIndex: from.end, endIndex: to.start } } },
        });
        break;
      }
    }
  }

  return requests.sort((a, b) => b.index - a.index).map((r) => r.req);
}

/** Parse a Docs API `documents.get` response into our model. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseDocument(raw: any): DocModel {
  const paragraphs: DocParagraph[] = [];
  const content = raw?.body?.content ?? [];

  for (const el of content) {
    if (!el.paragraph) continue;
    const elements = el.paragraph.elements ?? [];
    let text = '';
    const links: { text: string; url: string }[] = [];
    for (const e of elements) {
      const run = e.textRun;
      if (!run) continue;
      text += run.content ?? '';
      const url = run.textStyle?.link?.url;
      if (url) links.push({ text: (run.content ?? '').trim(), url });
    }
    paragraphs.push({
      start: el.startIndex ?? 0,
      end: el.endIndex ?? 0,
      text: text.replace(/\n$/, ''),
      style: el.paragraph.paragraphStyle?.namedStyleType,
      bullet: !!el.paragraph.bullet,
      links,
      isAnswerLine: isRuleLine(text),
    });
  }

  return {
    documentId: raw?.documentId ?? '',
    title: raw?.title ?? '(untitled)',
    revisionId: raw?.revisionId,
    paragraphs,
  };
}

/** Human-readable preview grouped by fix kind. */
export function describePlan(plan: FormatPlan): { kind: FixKind; label: string; count: number }[] {
  const byKind = new Map<FixKind, { label: string; count: number }>();
  for (const f of plan.fixes) {
    const existing = byKind.get(f.kind);
    if (existing) existing.count++;
    else byKind.set(f.kind, { label: f.label.replace(/\d+/g, 'n'), count: 1 });
  }
  return [...byKind.entries()].map(([kind, v]) => ({ kind, ...v }));
}
