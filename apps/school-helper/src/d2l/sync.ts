import { db, getSettings } from '../common/db';
import { mergeItem, markMissing } from '../common/merge';
import { BOARDS } from '../common/settings';
import type { BoardId, ChangeRecord, Course, SyncRun, WorkItem } from '../common/types';
import { D2lClient, type RequestLogEntry } from './client';
import { endpoints } from './endpoints';
import { saveFixture } from './capture';
import { ensureDurhamSession } from './sso';
import {
  applyProgress,
  parseContentTree,
  type D2lContentObject,
  type D2lUserProgress,
} from './parsers/content';
import {
  applySubmission,
  findHiddenFolderIds,
  parseDropboxFolder,
  type D2lDropboxFolder,
  type D2lSubmissionEntity,
} from './parsers/dropbox';
import {
  applyGrades,
  indexGrades,
  type D2lGradeObject,
  type D2lGradeValue,
} from './parsers/grades';
import { parseQuizzes, type D2lQuiz } from './parsers/quizzes';
import { parseDiscussions, type D2lDiscussionTopic, type D2lForum } from './parsers/discussions';
import { parseAnnouncements, type D2lNewsItem } from './parsers/news';
import { parseRubrics, type D2lRubric } from './parsers/rubrics';
import {
  knownCourses,
  parseEnrollments,
  type D2lEnrollment,
  type PagedResult,
} from './parsers/enrollments';

export interface SyncOptions {
  trigger: SyncRun['trigger'];
  boards?: BoardId[];
  courseIds?: string[];
  fetchImpl?: typeof fetch;
  onProgress?: (msg: string, pct: number) => void;
}

export interface SyncResult {
  run: SyncRun;
  changes: ChangeRecord[];
}

/**
 * Read both D2L tenants and fold the results into local storage.
 *
 * Read-only by construction: every request goes through D2lClient, which
 * refuses anything but GET and blocks state-changing URL shapes.
 */
export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const settings = await getSettings();
  const now = Date.now();
  const syncId = `sync-${now}`;
  const requests: RequestLogEntry[] = [];
  const errors: string[] = [];
  const allChanges: ChangeRecord[] = [];
  const report = opts.onProgress ?? (() => {});

  const onRequest = (e: RequestLogEntry) => {
    if (requests.length < 500) requests.push(e);
  };
  const onBody = settings.captureFixtures
    ? async (endpoint: string, url: string, status: number, body: string) => {
        try {
          await saveFixture({ board: guessBoard(url), endpoint, url, status, body });
        } catch {}
      }
    : undefined;

  const mk = (board: BoardId) =>
    new D2lClient(board, { fetchImpl: opts.fetchImpl, onRequest, onBody });
  const clients: Record<BoardId, D2lClient> = { ldsb: mk('ldsb'), durham: mk('durham') };

  const boards = opts.boards ?? (['ldsb', 'durham'] as BoardId[]);
  let itemsSeen = 0;

  // 1. Establish sessions, including the LDSB → Durham SSO jump.
  if (boards.includes('durham')) {
    report('Checking Durham session (SSO)…', 5);
    const sso = await ensureDurhamSession(clients.ldsb, clients.durham);
    if (!sso.ok) errors.push(`Durham SSO: ${sso.message}`);
  }

  // 2. Resolve the course list.
  report('Loading courses…', 10);
  const courses = await resolveCourses(clients, boards, errors, now);
  const targets = opts.courseIds ? courses.filter((c) => opts.courseIds!.includes(c.id)) : courses;
  await db.courses.bulkPut(courses);

  const touchedIds = new Set<string>();

  // 3. Per-course reads.
  for (const [i, course] of targets.entries()) {
    if (!boards.includes(course.board)) continue;
    const base = 15 + (i / Math.max(1, targets.length)) * 75;
    report(`Syncing ${course.code}…`, base);
    try {
      const client = clients[course.board];
      await client.negotiateVersions();
      const produced = await syncCourse(client, course, now, errors, report, base, targets.length);
      itemsSeen += produced.length;

      for (const incoming of produced) {
        touchedIds.add(incoming.id);
        const stored = await db.items.get(incoming.id);
        const { merged, changes } = mergeItem(stored, incoming, now);
        await db.items.put(merged);
        for (const c of changes) {
          allChanges.push({
            ...c,
            id: `${syncId}:${c.itemId ?? c.courseId}:${c.type}:${allChanges.length}`,
            syncId,
            seen: false,
          });
        }
      }

      await db.courses.update(course.id, { lastSyncedAt: now });
    } catch (err) {
      errors.push(`${course.code}: ${(err as Error).message}`);
    }
  }

  // 4. Flag items that disappeared — never delete.
  report('Reconciling…', 92);
  for (const course of targets) {
    const stored = await db.items.where('courseId').equals(course.id).toArray();
    for (const item of stored) {
      if (touchedIds.has(item.id)) continue;
      if (item.kind === 'other') continue;
      const { merged, changes } = markMissing(item, now);
      if (changes.length) {
        await db.items.put(merged);
        for (const c of changes) {
          allChanges.push({ ...c, id: `${syncId}:${item.id}:removed`, syncId, seen: false });
        }
      }
    }
  }

  if (allChanges.length) await db.changes.bulkPut(allChanges);

  const run: SyncRun = {
    id: syncId,
    startedAt: now,
    finishedAt: Date.now(),
    trigger: opts.trigger,
    boards,
    ok: errors.length === 0,
    itemsSeen,
    changes: allChanges.length,
    errors,
    requests,
  };
  await db.syncs.put(run);
  await db.settings
    .update('settings', { 'sync.lastFullSyncAt': Date.now() } as never)
    .catch(() => {});
  report('Done.', 100);

  return { run, changes: allChanges };
}

async function resolveCourses(
  clients: Record<BoardId, D2lClient>,
  boards: BoardId[],
  errors: string[],
  now: number,
): Promise<Course[]> {
  const found: Course[] = [];
  for (const board of boards) {
    try {
      const page = await clients[board].getJson<PagedResult<D2lEnrollment>>(
        endpoints.myEnrollments(),
        'myenrollments',
      );
      found.push(...parseEnrollments(page, board, now));
    } catch (err) {
      errors.push(`${BOARDS[board].label} course list: ${(err as Error).message}`);
    }
  }
  // Always include the three known courses so the tracker works even if the
  // enrolment read fails (expired session, tenant quirk, etc.).
  const byId = new Map(found.map((c) => [c.id, c]));
  for (const k of knownCourses(now)) {
    const existing = byId.get(k.id);
    byId.set(k.id, existing ? { ...k, ...existing, teacher: existing.teacher || k.teacher } : k);
  }
  return [...byId.values()];
}

async function syncCourse(
  client: D2lClient,
  course: Course,
  now: number,
  errors: string[],
  report: (m: string, p: number) => void,
  base: number,
  total: number,
): Promise<WorkItem[]> {
  /**
   * One failing read (a 500, a tenant that hides a tool, a transient timeout)
   * must never cost us the rest of the course. Each read is isolated and its
   * failure is reported rather than thrown.
   */
  const safeRead = async <T>(path: string, name: string, label: string): Promise<T | null> => {
    try {
      return await client.tryGetJson<T>(path, name);
    } catch (err) {
      errors.push(`${course.code} ${label}: ${(err as Error).message}`);
      return null;
    }
  };
  const origin = BOARDS[course.board].origin;
  const ou = course.orgUnitId;
  const ctx = { courseId: course.id, board: course.board, origin, orgUnitId: ou, now };
  const step = 75 / Math.max(1, total) / 7;
  let items: WorkItem[] = [];

  // Content tree
  report(`${course.code}: content`, base + step);
  const root = await safeRead<D2lContentObject[]>(
    endpoints.contentRoot(ou),
    'content-root',
    'content',
  );
  let activityLinks: {
    kind: 'assignment' | 'quiz' | 'discussion';
    remoteId: string;
    fromTopic: string;
    title: string;
  }[] = [];
  if (root) {
    const parsed = parseContentTree(root, ctx);
    activityLinks = parsed.activityLinks;
    let contentItems = parsed.items;
    const progress = await safeRead<D2lUserProgress[]>(
      endpoints.contentCompletions(ou),
      'content-progress',
      'progress',
    );
    if (progress) contentItems = applyProgress(contentItems, progress);
    items.push(...contentItems);
  }

  // Dropboxes, including ones hidden from the list but linked in content
  report(`${course.code}: assignments`, base + step * 2);
  const folders =
    (await safeRead<D2lDropboxFolder[]>(
      endpoints.dropboxFolders(ou),
      'dropbox-folders',
      'assignments',
    )) ?? [];
  const hiddenIds = findHiddenFolderIds(folders, activityLinks);
  const allFolders = [...folders];
  for (const id of hiddenIds) {
    const extra = await safeRead<D2lDropboxFolder>(
      endpoints.dropboxFolder(ou, id),
      'dropbox-folder',
      `assignment ${id}`,
    );
    if (extra) allFolders.push({ ...extra, IsHidden: true });
  }
  const linkedFromContent = new Set(
    activityLinks.filter((a) => a.kind === 'assignment').map((a) => a.remoteId),
  );

  const myUserId = await whoAmIId(client);
  for (const folder of allFolders) {
    let item = parseDropboxFolder(folder, { ...ctx, linkedFromContent });
    if (hiddenIds.includes(String(folder.Id))) item = { ...item, hiddenFromList: true };
    const subs = await safeRead<D2lSubmissionEntity[]>(
      endpoints.dropboxSubmissions(ou, String(folder.Id)),
      'dropbox-submissions',
      `submissions for ${folder.Name}`,
    );
    if (subs?.length) item = applySubmission(item, subs, myUserId);
    items.push(item);

    // Rubrics for this assignment
    const rubrics = await safeRead<D2lRubric[]>(
      endpoints.objectRubrics(ou, 'dropbox', String(folder.Id)),
      'rubrics',
      `rubric for ${folder.Name}`,
    );
    if (rubrics?.length) {
      const parsed = parseRubrics(rubrics, course.id, item.id);
      await db.rubrics.bulkPut(parsed);
      items[items.length - 1] = { ...item, rubricIds: parsed.map((r) => r.id) };
    }
  }

  // Quizzes
  report(`${course.code}: quizzes`, base + step * 3);
  const quizzes = await safeRead<{ Objects?: D2lQuiz[] } | D2lQuiz[]>(
    endpoints.quizzes(ou),
    'quizzes',
    'quizzes',
  );
  if (quizzes) {
    const list = Array.isArray(quizzes) ? quizzes : (quizzes.Objects ?? []);
    items.push(...parseQuizzes(list, ctx));
  }

  // Discussions
  report(`${course.code}: discussions`, base + step * 4);
  const forums = await safeRead<D2lForum[]>(
    endpoints.discussionForums(ou),
    'discussion-forums',
    'discussions',
  );
  if (forums?.length) {
    const topicsByForum: Record<string, D2lDiscussionTopic[]> = {};
    for (const f of forums) {
      const topics = await safeRead<D2lDiscussionTopic[]>(
        endpoints.discussionTopics(ou, String(f.ForumId)),
        'discussion-topics',
        `topics in ${f.Name}`,
      );
      topicsByForum[String(f.ForumId)] = topics ?? [];
    }
    items.push(...parseDiscussions(forums, topicsByForum, ctx));
  }

  // Announcements
  report(`${course.code}: announcements`, base + step * 5);
  const news = await safeRead<D2lNewsItem[]>(endpoints.news(ou), 'news', 'announcements');
  if (news) items.push(...parseAnnouncements(news, ctx));

  // Grades and weights
  report(`${course.code}: grades`, base + step * 6);
  const objects =
    (await safeRead<D2lGradeObject[]>(
      endpoints.gradeObjects(ou),
      'grade-objects',
      'grade items',
    )) ?? [];
  const values =
    (await safeRead<D2lGradeValue[]>(endpoints.myGradeValues(ou), 'my-grade-values', 'grades')) ??
    [];
  if (objects.length || values.length) {
    items = applyGrades(items, indexGrades(objects, values), objects);
    const weights: Record<string, number> = {};
    for (const o of objects) if (o.Weight != null) weights[o.Name] = o.Weight;
    if (Object.keys(weights).length) await db.courses.update(course.id, { weights });
  }

  return items;
}

async function whoAmIId(client: D2lClient): Promise<string | undefined> {
  try {
    const me = await client.getJson<{ Identifier?: string }>(endpoints.whoAmI(), 'whoami');
    return me?.Identifier;
  } catch {
    return undefined;
  }
}

function guessBoard(url: string): BoardId {
  return /durham/i.test(url) ? 'durham' : 'ldsb';
}

/** Human-readable roll-up of a sync, for the changes view and notifications. */
export function summariseChanges(changes: ChangeRecord[]): string {
  if (!changes.length) return 'No changes since the last sync.';
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  const label: Record<string, string> = {
    'new-item': 'new task',
    'due-date': 'due-date change',
    'new-grade': 'new grade',
    'new-feedback': 'new feedback',
    status: 'status change',
    'new-announcement': 'announcement',
    removed: 'removed item',
    other: 'other change',
  };
  return [...counts.entries()]
    .map(([type, n]) => `${n} ${label[type] ?? type}${n > 1 ? 's' : ''}`)
    .join(', ');
}
