import { describe, expect, it } from 'vitest';
import {
  buildRequests,
  describePlan,
  detectBlocks,
  isAnswerLabel,
  isQuestion,
  isRuleLine,
  parseDocument,
  planFormatting,
  type DocModel,
  type DocParagraph,
} from '../src/gdocs/formatter';

const para = (text: string, start: number, extra: Partial<DocParagraph> = {}): DocParagraph => ({
  start,
  end: start + text.length + 1,
  text,
  links: [],
  ...extra,
});

function build(texts: string[]): DocModel {
  let idx = 1;
  const paragraphs = texts.map((t) => {
    const p = para(t, idx);
    idx = p.end;
    return p;
  });
  return { documentId: 'doc1', title: 'Worksheet', revisionId: 'rev1', paragraphs };
}

describe('question / answer detection', () => {
  it('recognises the numbering styles worksheets actually use', () => {
    expect(isQuestion('1. What is trade?')).toBe(true);
    expect(isQuestion('Q2) Define tariff')).toBe(true);
    expect(isQuestion('(3) Explain')).toBe(true);
    expect(isQuestion('a) Give an example')).toBe(true);
    expect(isQuestion('Some ordinary sentence.')).toBe(false);
  });

  it('recognises answer labels', () => {
    expect(isAnswerLabel('Answer: exporting')).toBe(true);
    expect(isAnswerLabel('A. exporting')).toBe(true);
    expect(isAnswerLabel('Anyway, exporting')).toBe(false);
  });

  it('recognises leftover horizontal answer lines', () => {
    expect(isRuleLine('__________')).toBe(true);
    expect(isRuleLine('----------')).toBe(true);
    expect(isRuleLine('· · · · ·')).toBe(true);
    expect(isRuleLine('real text')).toBe(false);
  });
});

describe('format planning', () => {
  it('removes leftover answer lines and underscore blanks', () => {
    const plan = planFormatting(
      build(['1. What is trade?', '__________', 'Answer: The exchange of ____ goods.']),
    );
    const kinds = plan.fixes.map((f) => f.kind);
    expect(kinds).toContain('remove-rule');
    expect(kinds).toContain('remove-underscores');
    const underscoreFix = plan.fixes.find((f) => f.kind === 'remove-underscores')!;
    expect(underscoreFix.after).not.toContain('____');
  });

  it('asks for exactly four blank lines between question blocks', () => {
    const plan = planFormatting(build(['1. Q one', 'Answer: a', '', '2. Q two', 'Answer: b']));
    const spacing = plan.fixes.filter((f) => f.kind === 'spacing');
    expect(spacing.length).toBe(1);
    expect(spacing[0].after).toBe('4 blank lines');
  });

  it('leaves correctly spaced documents alone', () => {
    const plan = planFormatting(
      build(['1. Q one', 'Answer: a', '', '', '', '', '2. Q two', 'Answer: b']),
    );
    expect(plan.fixes.filter((f) => f.kind === 'spacing')).toHaveLength(0);
  });

  it('moves the answer directly under its question', () => {
    const plan = planFormatting(
      build(['1. Q one', '', '', 'Answer: a', '', '', '', '', '2. Q two', 'Answer: b']),
    );
    expect(plan.fixes.some((f) => f.kind === 'answer-position')).toBe(true);
  });

  it('splits inline lists onto their own lines', () => {
    const long =
      '1. Name the modes: - exporting is the cheapest route for most firms - licensing transfers the brand - joint ventures share the risk and the profit';
    const plan = planFormatting(build([long]));
    const split = plan.fixes.find((f) => f.kind === 'split-list');
    expect(split).toBeTruthy();
    expect(split!.after.split('\n').length).toBeGreaterThan(2);
  });

  it('turns bare URLs into links rather than leaving raw text', () => {
    const plan = planFormatting(build(['Answer: see https://example.com/report for the figures']));
    expect(plan.fixes.some((f) => f.kind === 'linkify-evidence')).toBe(true);
  });

  it('does not re-linkify URLs that are already links', () => {
    const doc = build(['Answer: see the report']);
    doc.paragraphs[0].text = 'Answer: see https://example.com/report';
    doc.paragraphs[0].links = [{ text: 'report', url: 'https://example.com/report' }];
    expect(planFormatting(doc).fixes.some((f) => f.kind === 'linkify-evidence')).toBe(false);
  });

  it('captures a snapshot so the change can be undone', () => {
    const plan = planFormatting(build(['1. Q', '__________']));
    expect(plan.snapshot).toContain('1. Q');
  });

  it('emits Docs API requests back-to-front so indices stay valid', () => {
    const doc = build(['1. Q one', '__________', '2. Q two', '__________']);
    const plan = planFormatting(doc);
    const requests = buildRequests(doc, plan.fixes) as {
      deleteContentRange?: { range: { startIndex: number } };
    }[];
    const starts = requests
      .filter((r) => r.deleteContentRange)
      .map((r) => r.deleteContentRange!.range.startIndex);
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
  });

  it('summarises the plan for the preview UI', () => {
    const plan = planFormatting(build(['1. Q', '__________', '2. Q', '__________']));
    const summary = describePlan(plan);
    expect(summary.find((s) => s.kind === 'remove-rule')!.count).toBe(2);
  });
});

describe('Docs API response parsing', () => {
  it('reads paragraphs, indices and existing links out of documents.get', () => {
    const doc = parseDocument({
      documentId: 'abc',
      title: 'My worksheet',
      revisionId: 'r1',
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 20,
            paragraph: {
              elements: [{ textRun: { content: '1. What is trade?\n' } }],
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            },
          },
          {
            startIndex: 20,
            endIndex: 50,
            paragraph: {
              elements: [
                { textRun: { content: 'Answer: see ' } },
                {
                  textRun: {
                    content: 'this source',
                    textStyle: { link: { url: 'https://example.com' } },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(doc.title).toBe('My worksheet');
    expect(doc.paragraphs).toHaveLength(2);
    expect(doc.paragraphs[0].text).toBe('1. What is trade?');
    expect(doc.paragraphs[1].links[0].url).toBe('https://example.com');
  });
});

describe('block detection', () => {
  it('groups questions with their answers and knows where the next question starts', () => {
    const doc = build(['1. Q one', 'Answer: a', '', '2. Q two', 'Answer: b']);
    const blocks = detectBlocks(doc.paragraphs);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].label).toBe('1');
    expect(blocks[0].nextQuestion).toBe(3);
    expect(blocks[1].nextQuestion).toBeNull();
  });
});
