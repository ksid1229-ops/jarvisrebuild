import { describe, expect, it } from 'vitest';
import root from '../src/d2l/fixtures/content-root.json';
import progressFixture from '../src/d2l/fixtures/content-progress.json';
import { applyProgress, parseContentTree, type D2lContentObject } from '../src/d2l/parsers/content';

const CTX = {
  courseId: 'ldsb:29940528',
  board: 'ldsb' as const,
  origin: 'https://ldsb.elearningontario.ca',
  now: 1_760_000_000_000,
};

describe('content tree parser', () => {
  const parsed = parseContentTree(root as D2lContentObject[], CTX);

  it('flattens modules and topics with parent links', () => {
    const unit1 = parsed.items.find((i) => i.remoteId === '801001');
    const lesson = parsed.items.find((i) => i.remoteId === '802001');
    expect(unit1?.kind).toBe('unit');
    expect(lesson?.kind).toBe('lesson');
    expect(lesson?.parentId).toBe('ldsb:29940528:unit:801001');
  });

  it('parses D2L ISO dates into epoch millis', () => {
    const lesson = parsed.items.find((i) => i.remoteId === '802001');
    expect(lesson?.dueAt).toBe(Date.parse('2026-09-12T03:59:00.000Z'));
  });

  it('falls back to module dates for modules', () => {
    const unit2 = parsed.items.find((i) => i.remoteId === '801002');
    expect(unit2?.dueAt).toBe(Date.parse('2026-11-20T04:59:00.000Z'));
    expect(unit2?.startAt).toBe(Date.parse('2026-10-11T04:00:00.000Z'));
  });

  it('extracts the sources a lesson provides, including slides and articles', () => {
    const lesson = parsed.items.find((i) => i.remoteId === '802001')!;
    const urls = lesson.sources!.map((s) => s.url);
    expect(urls).toContain(
      'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit',
    );
    expect(urls.some((u) => u.includes('cbc.ca'))).toBe(true);
    expect(lesson.sources!.find((s) => s.url.includes('presentation'))!.kind).toBe('slides');
  });

  it('picks up bare Google Docs URLs that were never hyperlinked', () => {
    const lesson = parsed.items.find((i) => i.remoteId === '802010')!;
    expect(lesson.sources!.some((s) => s.url.includes('1CultureNotesDocIdXyz9876543210'))).toBe(
      true,
    );
  });

  it('detects activity links to dropboxes and quizzes hidden inside content', () => {
    expect(parsed.activityLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'assignment', remoteId: '550012' }),
        expect.objectContaining({ kind: 'quiz', remoteId: '44021' }),
      ]),
    );
  });

  it('does not turn an activity link into a source', () => {
    const submitTopic = parsed.items.find((i) => i.remoteId === '802003')!;
    expect(submitTopic.sources).toBeUndefined();
  });

  it('applies visit progress to lessons only', () => {
    const withProgress = applyProgress(parsed.items, progressFixture);
    expect(withProgress.find((i) => i.remoteId === '802001')!.status).toBe('submitted');
    expect(withProgress.find((i) => i.remoteId === '802002')!.status).toBe('in-progress');
    expect(withProgress.find((i) => i.remoteId === '802010')!.status).toBe('not-started');
    expect(withProgress.find((i) => i.remoteId === '801001')!.status).toBe('unknown');
  });
});
