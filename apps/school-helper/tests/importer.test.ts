import { describe, expect, it } from 'vitest';
import {
  detectKind,
  detectStatus,
  importSeedFiles,
  parseLooseDate,
  readTable,
} from '../src/importer/markdown';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');

const TRACKER = `# BBB4M0-01 International Business

## Unit 1

| Task | Type | Due | Weight | Status | Notes |
|------|------|-----|--------|--------|-------|
| Unit 1 Worksheet | Drop box | 2026-09-19 | 5% | Submitted | went in late |
| Unit 1 Check-in Quiz | Quiz | Sep 20 | 3% | Not started | |
| Culture Report | Assignment | 11/14 | 15% | | two pages |

### Questions for Ms. Pardy
- [ ] Does the report need APA citations?
- [x] Is the worksheet out of 20?

# ENG4UE-02 English

- [ ] Seminar prep — due Oct 3
- [x] Reading response 2
`;

describe('seed markdown importer', () => {
  const bundle = importSeedFiles([{ name: '01_tracker.md', text: TRACKER }], NOW);

  it('creates the three known courses', () => {
    expect(bundle.courses.map((c) => c.code).sort()).toEqual(['BBB4M0-01', 'CIA4U', 'ENG4UE-02']);
  });

  it('reads a markdown table into work items with dates, weights and status', () => {
    const ws = bundle.items.find((i) => i.title === 'Unit 1 Worksheet')!;
    expect(ws.courseId).toBe('ldsb:29940528');
    expect(ws.weight).toBe(5);
    expect(ws.status).toBe('submitted');
    expect(new Date(ws.dueAt!).toISOString().slice(0, 10)).toBe('2026-09-19');
  });

  it('classifies item kinds from the type column', () => {
    expect(bundle.items.find((i) => i.title === 'Unit 1 Check-in Quiz')!.kind).toBe('quiz');
    expect(bundle.items.find((i) => i.title === 'Unit 1 Worksheet')!.kind).toBe('assignment');
  });

  it('routes "Questions for <Teacher>" sections into the teacher question list', () => {
    const qs = bundle.questions.filter((q) => q.teacher === 'Ms. Pardy');
    expect(qs).toHaveLength(2);
    expect(qs.find((q) => q.question.includes('APA'))!.asked).toBe(false);
    expect(qs.find((q) => q.question.includes('out of 20'))!.asked).toBe(true);
  });

  it('switches course context on a heading and reads checklists', () => {
    const eng = bundle.items.filter((i) => i.courseId === 'ldsb:29940585');
    expect(eng.map((i) => i.title)).toContain('Seminar prep');
    expect(eng.find((i) => i.title === 'Reading response 2')!.completed).toBe(true);
  });

  it('marks seeded items as not-yet-synced so sync can claim them', () => {
    expect(bundle.items.every((i) => i.presentInLastSync === false)).toBe(true);
  });

  it('stores a style guide file verbatim instead of parsing it', () => {
    const out = importSeedFiles(
      [{ name: '04_style_guide.md', text: '# My voice\nShort sentences.' }],
      NOW,
    );
    expect(out.styleGuide).toContain('Short sentences.');
    expect(out.items).toHaveLength(0);
  });

  it('keeps handoff notes rather than dropping them', () => {
    const out = importSeedFiles(
      [{ name: '06_bbb4m_handoff.md', text: '# Handoff\n- context' }],
      NOW,
    );
    expect(out.handoffNotes[0].file).toBe('06_bbb4m_handoff.md');
  });
});

describe('loose date parsing', () => {
  it('handles the formats school docs actually use', () => {
    expect(new Date(parseLooseDate('2026-05-04', NOW)!).toISOString().slice(0, 10)).toBe(
      '2026-05-04',
    );
    expect(new Date(parseLooseDate('Sep 20', NOW)!).getMonth()).toBe(8);
    expect(new Date(parseLooseDate('due Friday May 4, 2027', NOW)!).getFullYear()).toBe(2027);
    expect(parseLooseDate('TBD', NOW)).toBeNull();
    expect(parseLooseDate('', NOW)).toBeNull();
  });

  it('rolls January dates into the next calendar year of the school year', () => {
    const jan = parseLooseDate('Jan 15', NOW)!;
    expect(new Date(jan).getFullYear()).toBe(2027);
  });
});

describe('table and word helpers', () => {
  it('reads a table with normalised headers', () => {
    const lines = ['| Task | Due Date |', '|---|---|', '| A | Sep 1 |', '', 'other'];
    const { rows, consumed } = readTable(lines, 0);
    expect(rows[0]).toEqual({ task: 'A', duedate: 'Sep 1' });
    expect(consumed).toBe(3);
  });

  it('detects kinds and statuses from free text', () => {
    expect(detectKind('Unit 3 test')).toBe('quiz');
    expect(detectKind('Discussion post 2')).toBe('discussion');
    expect(detectStatus('marked 18/20')).toBe('graded');
    expect(detectStatus('overdue')).toBe('not-started');
  });
});
