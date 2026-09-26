import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/common/db';
import { runSync, summariseChanges } from '../src/d2l/sync';
import contentRoot from '../src/d2l/fixtures/content-root.json';
import contentProgress from '../src/d2l/fixtures/content-progress.json';
import dropboxFolders from '../src/d2l/fixtures/dropbox-folders.json';
import hiddenFolder from '../src/d2l/fixtures/dropbox-hidden-folder.json';
import submissions from '../src/d2l/fixtures/dropbox-submissions.json';
import grades from '../src/d2l/fixtures/grades.json';
import quizzes from '../src/d2l/fixtures/quizzes.json';
import discussions from '../src/d2l/fixtures/discussions.json';
import news from '../src/d2l/fixtures/news.json';
import rubrics from '../src/d2l/fixtures/rubrics.json';
import enrollments from '../src/d2l/fixtures/enrollments.json';

/** A fake D2L that serves the fixtures and records every request it receives. */
function makeFakeD2l() {
  const seen: { url: string; method: string }[] = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method ?? 'GET' });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (url.includes('/versions/'))
      return json([
        { ProductCode: 'lp', SupportedVersions: ['1.31'] },
        { ProductCode: 'le', SupportedVersions: ['1.69'] },
      ]);
    if (url.includes('whoami')) return json({ Identifier: '4455661', FirstName: 'Sid' });
    if (url.includes('myenrollments')) return json(enrollments);
    if (url.includes('/content/root/')) return json(contentRoot);
    if (url.includes('/content/userprogress/')) return json(contentProgress);
    if (url.includes('/dropbox/folders/550099')) return json(hiddenFolder);
    if (/\/dropbox\/folders\/\d+\/submissions\//.test(url)) return json(submissions);
    if (url.includes('/dropbox/folders/')) return json(dropboxFolders);
    if (url.includes('/rubrics/dropbox/550012')) return json(rubrics);
    if (url.includes('/rubrics/')) return json([]);
    if (url.includes('/quizzes/')) return json(quizzes);
    if (url.includes('/discussions/forums/33001/topics/')) return json(discussions.topics['33001']);
    if (url.includes('/discussions/forums/')) return json(discussions.forums);
    if (url.includes('/news/')) return json(news);
    if (url.includes('myGradeValues')) return json(grades.values);
    if (url.includes('/grades/')) return json(grades.objects);
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, seen };
}

beforeEach(async () => {
  await Promise.all([
    db.items.clear(),
    db.courses.clear(),
    db.changes.clear(),
    db.syncs.clear(),
    db.rubrics.clear(),
    db.settings.clear(),
  ]);
});

describe('end-to-end sync against fixtures', () => {
  it('IS STRICTLY READ-ONLY — every request is a GET', async () => {
    const { fetchImpl, seen } = makeFakeD2l();
    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.every((r) => r.method === 'GET')).toBe(true);
  });

  it('never touches a submit, post, or mark-as-read endpoint', async () => {
    const { fetchImpl, seen } = makeFakeD2l();
    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });
    expect(seen.some((r) => /submit|markasread|\/post\b/i.test(r.url))).toBe(false);
  });

  it('stores content, assignments, quizzes, discussions and announcements', async () => {
    const { fetchImpl } = makeFakeD2l();
    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });
    const items = await db.items.where('courseId').equals('ldsb:29940528').toArray();
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds).toContain('unit');
    expect(kinds).toContain('lesson');
    expect(kinds).toContain('assignment');
    expect(kinds).toContain('quiz');
    expect(kinds).toContain('discussion');
    expect(kinds).toContain('announcement');
  });

  it('finds the dropbox that is linked from content but hidden from the list', async () => {
    const { fetchImpl } = makeFakeD2l();
    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });
    const hidden = await db.items.get('ldsb:29940528:assignment:550099');
    expect(hidden).toBeTruthy();
    expect(hidden!.hiddenFromList).toBe(true);
    expect(hidden!.title).toContain('Make-up Task');
  });

  it('attaches my grade, feedback and the gradebook weight', async () => {
    const { fetchImpl } = makeFakeD2l();
    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });
    const ws = await db.items.get('ldsb:29940528:assignment:550012');
    expect(ws!.grade).toBe(17);
    expect(ws!.weight).toBe(5);
    expect(ws!.feedback).toContain('Expand question 4');
    expect(ws!.status).toBe('graded');
  });

  it('stores the level-4 rubric for the assignment', async () => {
    const { fetchImpl } = makeFakeD2l();
    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });
    const stored = await db.rubrics.toArray();
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0].criteria[0].level4).toContain('thorough understanding');
  });

  it('DIFFS against the previous sync and reports only what changed', async () => {
    const { fetchImpl } = makeFakeD2l();
    const first = await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });
    expect(first.changes.every((c) => c.type === 'new-item')).toBe(true);

    const second = await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });
    expect(second.changes).toHaveLength(0);

    // Now the teacher moves a due date.
    const moved = JSON.parse(JSON.stringify(dropboxFolders));
    moved[0].DueDate = '2026-09-26T03:59:00.000Z';
    const patched = (async (url: string, init?: RequestInit) => {
      if (url.includes('/dropbox/folders/') && !/submissions|550099/.test(url)) {
        return new Response(JSON.stringify(moved), { status: 200 });
      }
      return fetchImpl(url as unknown as RequestInfo, init);
    }) as unknown as typeof fetch;

    const third = await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl: patched });
    const dueChange = third.changes.find((c) => c.type === 'due-date');
    expect(dueChange).toBeTruthy();
    expect(dueChange!.detail).toMatch(/Due date/);
  });

  it('MANUAL EDITS SURVIVE A REAL SYNC', async () => {
    const { fetchImpl } = makeFakeD2l();
    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });

    const id = 'ldsb:29940528:assignment:550013';
    const stored = (await db.items.get(id))!;
    const pinnedDue = Date.parse('2027-01-01T05:00:00.000Z');
    await db.items.put({
      ...stored,
      dueAt: pinnedDue,
      notes: 'ask Ms. Pardy about length',
      overrides: { dueAt: { field: 'dueAt', value: pinnedDue, editedAt: Date.now() } },
    });

    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });
    const after = (await db.items.get(id))!;
    expect(after.dueAt).toBe(pinnedDue);
    expect(after.notes).toBe('ask Ms. Pardy about length');
  });

  it('flags items that vanish instead of deleting them', async () => {
    const { fetchImpl } = makeFakeD2l();
    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });

    const shrunk = (async (url: string, init?: RequestInit) => {
      if (url.includes('/quizzes/'))
        return new Response(JSON.stringify({ Objects: [] }), { status: 200 });
      return fetchImpl(url as unknown as RequestInfo, init);
    }) as unknown as typeof fetch;

    const run = await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl: shrunk });
    const quiz = await db.items.get('ldsb:29940528:quiz:44021');
    expect(quiz).toBeTruthy();
    expect(quiz!.presentInLastSync).toBe(false);
    expect(run.changes.some((c) => c.type === 'removed')).toBe(true);
  });

  it('records a sync run with a GET-only request log', async () => {
    const { fetchImpl } = makeFakeD2l();
    const { run } = await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl });
    const stored = await db.syncs.get(run.id);
    expect(stored!.requests.length).toBeGreaterThan(0);
    expect(stored!.itemsSeen).toBeGreaterThan(5);
  });

  it('keeps going when one course read fails', async () => {
    const flaky = (async (url: string) => {
      if (url.includes('/content/root/')) return new Response('{}', { status: 500 });
      return makeFakeD2l().fetchImpl(url as unknown as RequestInfo);
    }) as unknown as typeof fetch;
    const { run } = await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl: flaky });
    expect(run.errors.length).toBeGreaterThan(0);
    expect(await db.items.count()).toBeGreaterThan(0);
  });

  it('summarises a change set in plain language', () => {
    expect(summariseChanges([])).toMatch(/No changes/);
    const summary = summariseChanges([
      {
        id: '1',
        syncId: 's',
        at: 0,
        courseId: 'c',
        type: 'new-item',
        title: 't',
        detail: '',
        seen: false,
      },
      {
        id: '2',
        syncId: 's',
        at: 0,
        courseId: 'c',
        type: 'new-grade',
        title: 't',
        detail: '',
        seen: false,
      },
      {
        id: '3',
        syncId: 's',
        at: 0,
        courseId: 'c',
        type: 'new-grade',
        title: 't',
        detail: '',
        seen: false,
      },
    ]);
    expect(summary).toContain('1 new task');
    expect(summary).toContain('2 new grades');
  });
});
