import { beforeEach, describe, expect, it } from 'vitest';
import { db, exportAll, getSettings, importAll, saveSettings } from '../src/common/db';
import { encryptSecret } from '../src/common/crypto';
import type { WorkItem } from '../src/common/types';

const item = (id: string): WorkItem => ({
  id,
  courseId: 'ldsb:29940528',
  board: 'ldsb',
  kind: 'assignment',
  remoteId: id,
  title: `Task ${id}`,
  status: 'not-started',
  notes: 'my note',
  firstSeenAt: 1,
  lastSeenAt: 1,
  presentInLastSync: true,
});

beforeEach(async () => {
  await Promise.all([
    db.items.clear(),
    db.courses.clear(),
    db.questions.clear(),
    db.settings.clear(),
    db.changes.clear(),
  ]);
});

describe('backup and restore', () => {
  it('round-trips every table', async () => {
    await db.items.bulkPut([item('1'), item('2')]);
    await db.courses.put({
      id: 'ldsb:29940528',
      board: 'ldsb',
      orgUnitId: '29940528',
      code: 'BBB4M0-01',
      name: 'International Business',
      teacher: 'Ms. Pardy',
      colour: '#3b82f6',
      active: true,
    });
    await db.questions.put({
      id: 'q1',
      courseId: 'ldsb:29940528',
      teacher: 'Ms. Pardy',
      question: 'APA?',
      asked: false,
      answered: false,
      createdAt: 1,
      updatedAt: 1,
    });

    const backup = await exportAll(false);
    await Promise.all([db.items.clear(), db.courses.clear(), db.questions.clear()]);

    const result = await importAll(backup, 'replace');
    expect(result.ok).toBe(true);
    expect(await db.items.count()).toBe(2);
    expect((await db.items.get('1'))!.notes).toBe('my note');
    expect(await db.questions.count()).toBe(1);
  });

  it('EXCLUDES API keys from a normal export', async () => {
    const settings = await getSettings();
    await saveSettings({
      providers: {
        ...settings.providers,
        cheap: { ...settings.providers.cheap, apiKeyCipher: await encryptSecret('sk-secret') },
      },
    });
    const backup = await exportAll(false);
    expect(backup).not.toContain('apiKeyCipher');
    expect(JSON.parse(backup).includesSecrets).toBe(false);
  });

  it('includes encrypted keys only when explicitly asked', async () => {
    const settings = await getSettings();
    await saveSettings({
      providers: {
        ...settings.providers,
        cheap: { ...settings.providers.cheap, apiKeyCipher: await encryptSecret('sk-secret') },
      },
    });
    const backup = await exportAll(true);
    expect(backup).toContain('apiKeyCipher');
    expect(backup).not.toContain('sk-secret');
  });

  it('never wipes a locally-stored key when restoring a key-less backup', async () => {
    const settings = await getSettings();
    await saveSettings({
      providers: {
        ...settings.providers,
        cheap: { ...settings.providers.cheap, apiKeyCipher: await encryptSecret('sk-keep-me') },
      },
    });
    const backup = await exportAll(false);
    await importAll(backup, 'merge');
    const after = await getSettings();
    expect(after.providers.cheap.apiKeyCipher).toBeTruthy();
  });

  it('merge mode keeps rows that are not in the backup', async () => {
    await db.items.put(item('1'));
    const backup = await exportAll(false);
    await db.items.put(item('2'));
    await importAll(backup, 'merge');
    expect(await db.items.count()).toBe(2);
  });

  it('rejects a file that is not a School Helper backup', async () => {
    expect((await importAll('{"format":"something-else"}')).ok).toBe(false);
    expect((await importAll('not json at all')).error).toMatch(/JSON/);
  });
});
