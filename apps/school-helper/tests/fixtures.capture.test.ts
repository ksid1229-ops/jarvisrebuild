import { beforeEach, describe, expect, it } from 'vitest';
import { db, saveSettings } from '../src/common/db';
import { clearFixtures, exportFixtures, redactAggressive, redactBody, saveFixture } from '../src/d2l/capture';
import { runSync } from '../src/d2l/sync';
import contentRoot from '../src/d2l/fixtures/content-root.json';
import enrollments from '../src/d2l/fixtures/enrollments.json';

/**
 * Step 0 of the Jarvis/scribe task: prove the capture → export path Sid will
 * actually run on his real D2L works, because KNOWN_ISSUES #1 depends on it.
 */

function fakeD2l() {
  return (async (url: string) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.includes('/versions/')) return json([{ ProductCode: 'le', SupportedVersions: ['1.69'] }]);
    if (url.includes('whoami')) return json({ Identifier: '4455661', DisplayName: 'Sid Example' });
    if (url.includes('myenrollments')) return json(enrollments);
    if (url.includes('/content/root/')) return json(contentRoot);
    return new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await Promise.all([db.fixtures.clear(), db.items.clear(), db.courses.clear(), db.settings.clear(), db.syncs.clear(), db.changes.clear()]);
});

describe('capture debug fixtures (the flow Sid runs on real D2L)', () => {
  it('captures nothing when the setting is off', async () => {
    await saveSettings({ captureFixtures: false });
    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl: fakeD2l() });
    expect(await db.fixtures.count()).toBe(0);
  });

  it('captures responses during a sync when the setting is on', async () => {
    await saveSettings({ captureFixtures: true });
    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl: fakeD2l() });
    const captured = await db.fixtures.toArray();
    expect(captured.length).toBeGreaterThan(3);
    expect(captured.map((f) => f.endpoint)).toContain('content-root');
  });

  it('REDACTS the student name out of a captured whoami before it is stored', async () => {
    await saveSettings({ captureFixtures: true });
    await runSync({ trigger: 'manual', boards: ['ldsb'], fetchImpl: fakeD2l() });
    const all = await db.fixtures.toArray();
    const blob = all.map((f) => f.body).join('\n');
    expect(blob).not.toContain('Sid Example');
  });

  it('exports a shareable bundle with parsed bodies and a redaction count', async () => {
    await saveFixture({ board: 'ldsb', endpoint: 'content-root', url: 'https://x/api?token=abc', status: 200, body: JSON.stringify({ Id: 1, DisplayName: 'Sid' }) });
    const bundle = JSON.parse(await exportFixtures());
    expect(bundle.format).toBe('school-helper-fixtures');
    expect(bundle.count).toBe(1);
    expect(bundle.fixtures[0].body.Id).toBe(1);
    expect(bundle.fixtures[0].body.DisplayName).toBe('REDACTED');
    expect(bundle.fixtures[0].url).toContain('token=REDACTED');
    expect(bundle.fixtures[0].redactions).toBeGreaterThan(0);
  });

  it('exports an empty but valid bundle when nothing was captured', async () => {
    const bundle = JSON.parse(await exportFixtures());
    expect(bundle.count).toBe(0);
    expect(Array.isArray(bundle.fixtures)).toBe(true);
  });

  it('clears captured fixtures on request', async () => {
    await saveFixture({ board: 'ldsb', endpoint: 'news', url: 'https://x', status: 200, body: '{}' });
    await clearFixtures();
    expect(await db.fixtures.count()).toBe(0);
  });

  it('aggressive mode also masks long numeric ids', () => {
    const { body } = redactAggressive(JSON.stringify({ note: 'student 44556613 enrolled' }));
    expect(body).not.toContain('44556613');
  });

  it('survives a non-JSON (HTML login page) response without throwing', () => {
    const { body } = redactBody('<html><body>sid@student.ldsb.ca</body></html>');
    expect(body).not.toContain('sid@student.ldsb.ca');
  });
});
