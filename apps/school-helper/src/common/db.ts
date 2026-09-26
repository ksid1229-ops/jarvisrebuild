import Dexie, { type Table } from 'dexie';
import type {
  JarvisLogEntry,
  JarvisOutboxEntry,
  ScribeSession,
  AiCallRecord,
  ChangeRecord,
  Course,
  FixtureCapture,
  Rubric,
  Settings,
  SyncRun,
  TeacherQuestion,
  UndoRecord,
  WorkItem,
} from './types';
import { DEFAULT_SETTINGS } from './settings';

export class SchoolHelperDb extends Dexie {
  courses!: Table<Course, string>;
  items!: Table<WorkItem, string>;
  rubrics!: Table<Rubric, string>;
  questions!: Table<TeacherQuestion, string>;
  changes!: Table<ChangeRecord, string>;
  syncs!: Table<SyncRun, string>;
  aiCalls!: Table<AiCallRecord, string>;
  settings!: Table<Settings, string>;
  fixtures!: Table<FixtureCapture, string>;
  undos!: Table<UndoRecord, string>;
  jarvisOutbox!: Table<JarvisOutboxEntry, string>;
  jarvisLog!: Table<JarvisLogEntry, string>;
  scribeSessions!: Table<ScribeSession, string>;

  constructor(name = 'school-helper') {
    super(name);
    this.version(1).stores({
      courses: 'id, board, code, active',
      items: 'id, courseId, board, kind, dueAt, status, parentId, completed, presentInLastSync',
      rubrics: 'id, courseId, itemId',
      questions: 'id, courseId, teacher, asked, answered',
      changes: 'id, syncId, courseId, itemId, type, at, seen',
      syncs: 'id, startedAt, ok',
      aiCalls: 'id, at, role, feature',
      settings: 'id',
      fixtures: 'id, at, board, endpoint',
      undos: 'id, at, docId, applied',
    });
    // v1.1.0 — Jarvis link outbox/log and scribe sessions.
    this.version(2).stores({
      jarvisOutbox: 'id, createdAt, host, courseId, nextAttemptAt',
      jarvisLog: 'id, at, endpoint, ok',
      scribeSessions: 'id, itemId, courseId, updatedAt',
    });
  }
}

export const db = new SchoolHelperDb();

export async function getSettings(): Promise<Settings> {
  const existing = await db.settings.get('settings');
  if (existing) return { ...DEFAULT_SETTINGS, ...existing, id: 'settings' };
  await db.settings.put(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = { ...current, ...patch, id: 'settings' };
  await db.settings.put(next);
  return next;
}

/** Full local backup. API keys are excluded unless includeSecrets is set. */
export async function exportAll(includeSecrets = false): Promise<string> {
  const [courses, items, rubrics, questions, changes, syncs, aiCalls, settings, undos] =
    await Promise.all([
      db.courses.toArray(),
      db.items.toArray(),
      db.rubrics.toArray(),
      db.questions.toArray(),
      db.changes.toArray(),
      db.syncs.toArray(),
      db.aiCalls.toArray(),
      getSettings(),
      db.undos.toArray(),
    ]);

  const safeSettings = structuredClone(settings);
  if (!includeSecrets) {
    for (const role of ['cheap', 'strong'] as const) {
      delete safeSettings.providers[role].apiKeyCipher;
    }
  }

  return JSON.stringify(
    {
      format: 'school-helper-backup',
      version: 1,
      exportedAt: Date.now(),
      includesSecrets: includeSecrets,
      data: {
        courses,
        items,
        rubrics,
        questions,
        changes,
        syncs,
        aiCalls,
        settings: safeSettings,
        undos,
      },
    },
    null,
    2,
  );
}

export interface ImportResult {
  ok: boolean;
  counts: Record<string, number>;
  error?: string;
}

export async function importAll(
  json: string,
  mode: 'merge' | 'replace' = 'merge',
): Promise<ImportResult> {
  let parsed: { format?: string; data?: Record<string, unknown[]> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, counts: {}, error: 'Not valid JSON.' };
  }
  if (parsed.format !== 'school-helper-backup' || !parsed.data) {
    return { ok: false, counts: {}, error: 'Not a School Helper backup file.' };
  }
  const d = parsed.data;
  const counts: Record<string, number> = {};

  await db.transaction(
    'rw',
    [
      db.courses,
      db.items,
      db.rubrics,
      db.questions,
      db.changes,
      db.syncs,
      db.aiCalls,
      db.settings,
      db.undos,
    ],
    async () => {
      if (mode === 'replace') {
        await Promise.all([
          db.courses.clear(),
          db.items.clear(),
          db.rubrics.clear(),
          db.questions.clear(),
          db.changes.clear(),
          db.syncs.clear(),
          db.aiCalls.clear(),
          db.undos.clear(),
        ]);
      }
      const tables = {
        courses: db.courses,
        items: db.items,
        rubrics: db.rubrics,
        questions: db.questions,
        changes: db.changes,
        syncs: db.syncs,
        aiCalls: db.aiCalls,
        undos: db.undos,
      } as const;
      for (const [key, table] of Object.entries(tables)) {
        const rows = d[key];
        if (Array.isArray(rows) && rows.length) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (table as any).bulkPut(rows);
          counts[key] = rows.length;
        }
      }
      if (d.settings && !Array.isArray(d.settings)) {
        const s = d.settings as unknown as Settings;
        const current = await db.settings.get('settings');
        // Never clobber existing local keys with a key-less backup.
        if (current) {
          for (const role of ['cheap', 'strong'] as const) {
            if (!s.providers?.[role]?.apiKeyCipher && current.providers?.[role]?.apiKeyCipher) {
              s.providers[role].apiKeyCipher = current.providers[role].apiKeyCipher;
            }
          }
        }
        await db.settings.put({ ...s, id: 'settings' });
        counts.settings = 1;
      }
    },
  );

  return { ok: true, counts };
}
