import { describe, expect, it } from 'vitest';
import {
  countSentences,
  enforceNotesOnly,
  isOpinionQuestion,
  stanceOptions,
  wordCount,
} from '../src/ai/guardrails';
import { collectFlags, parseNotes } from '../src/ai/answerNotes';
import { parseFindings, coverage } from '../src/ai/rubricCheck';

describe('academic honesty enforcement', () => {
  it('REJECTS drafted prose that a student could paste in', () => {
    const drafted = `International business refers to trade across borders. It matters because economies are interconnected. Canada relies heavily on exports to the United States, which shapes its policy choices.`;
    const out = enforceNotesOnly(drafted);
    expect(out.modified).toBe(true);
    expect(out.text).not.toContain('International business refers to');
    expect(out.violations.join(' ')).toMatch(/drafted prose/i);
  });

  it('keeps legitimate note bullets untouched', () => {
    const notes = `### Q1 Entry modes\n- Exporting is lowest risk [S1]\n- Joint ventures share cost and control [S1]`;
    const out = enforceNotesOnly(notes);
    expect(out.modified).toBe(false);
    expect(out.text).toContain('Joint ventures share cost');
  });

  it('shortens bullets that creep into paragraph length', () => {
    const long = `- ${'word '.repeat(45)}[S1]`;
    const out = enforceNotesOnly(long);
    expect(out.text).toContain('[shortened: notes only]');
    expect(out.violations.length).toBe(1);
  });

  it('rejects the whole reply when nothing survives', () => {
    const out = enforceNotesOnly(
      'This is a full answer. It has several sentences. It would be submitted directly.',
    );
    expect(out.text).toMatch(/drafted prose/i);
    expect(out.violations.length).toBeGreaterThan(0);
  });

  it('counts words and sentences the way the guard expects', () => {
    expect(wordCount('one two three')).toBe(3);
    expect(countSentences('A. B! C?')).toBe(3);
  });
});

describe('opinion questions', () => {
  it('detects questions that need the student to pick a side', () => {
    expect(isOpinionQuestion('Do you agree that tariffs protect jobs?')).toBe(true);
    expect(isOpinionQuestion('To what extent did NAFTA help Canada?')).toBe(true);
    expect(isOpinionQuestion('Should Canada join more trade blocs?')).toBe(true);
    expect(isOpinionQuestion('List the four modes of market entry.')).toBe(false);
    expect(isOpinionQuestion('Define comparative advantage.')).toBe(false);
  });

  it('offers sensible stance options per question shape', () => {
    expect(stanceOptions('Do you agree with free trade?')).toContain('Agree');
    expect(stanceOptions('To what extent was it effective?')[0]).toMatch(/great extent/i);
    expect(stanceOptions('Should Canada act?')).toContain('Yes, it should');
  });
});

describe('evidence traceability', () => {
  it('flags every claim the model brought in from outside the sources', () => {
    const md = `### Q1\n- Trade grew 4% [S1]\n- NOT IN SOURCE: Canada left NAFTA in 2019`;
    expect(collectFlags(md)).toHaveLength(1);
    expect(collectFlags(md)[0]).toContain('Canada left NAFTA');
  });

  it('parses bullets back into per-claim evidence links', () => {
    const md = `### Q1 Entry modes\n- Exporting is lowest risk [S1]\n- NOT IN SOURCE: made-up stat`;
    const parsed = parseNotes(md, [{ n: 1, title: 'Slides', url: 'https://example.com/slides' }]);
    expect(parsed[0].bullets[0].sourceUrl).toBe('https://example.com/slides');
    expect(parsed[0].bullets[0].inSource).toBe(true);
    expect(parsed[0].bullets[1].inSource).toBe(false);
  });
});

describe('rubric check parsing', () => {
  const myAnswer = 'Exporting is the cheapest way in. Joint ventures split the risk.';

  it('parses the JSON reply, even inside a code fence', () => {
    const raw =
      '```json\n{"overall":"Close to level 4.","findings":[{"criterion":"Knowledge","verdict":"close","missing":["a second example"],"factualErrors":[],"edits":[{"before":"Exporting is the cheapest way in.","after":"Exporting is the lowest-cost entry mode.","why":"precision"}]}]}\n```';
    const out = parseFindings(raw, myAnswer);
    expect(out.overall).toBe('Close to level 4.');
    expect(out.findings[0].edits).toHaveLength(1);
  });

  it('DROPS suggested edits whose "before" is not actually in my text — no invented content', () => {
    const raw =
      '{"overall":"x","findings":[{"criterion":"K","verdict":"close","missing":[],"factualErrors":[],"edits":[{"before":"A sentence I never wrote.","after":"Something else.","why":"n/a"}]}]}';
    expect(parseFindings(raw, myAnswer).findings[0].edits).toHaveLength(0);
  });

  it('degrades gracefully when the model ignores the JSON format', () => {
    const out = parseFindings('Sorry, here is some prose instead.', myAnswer);
    expect(out.findings).toHaveLength(0);
    expect(out.overall).toContain('prose');
  });

  it('computes level-4 coverage', () => {
    expect(
      coverage([
        { criterion: 'a', verdict: 'meets-level-4', missing: [], factualErrors: [], edits: [] },
        { criterion: 'b', verdict: 'missing', missing: [], factualErrors: [], edits: [] },
      ]),
    ).toEqual({ met: 1, total: 2, pct: 50 });
  });
});
