/**
 * Builds collector-compatible observation batches: one batch per course.
 *
 * Equivalent to `collectHost` in apps/d2l-extension/collector.js, reimplemented
 * in TypeScript against School Helper's GET-only reader. School Helper replaces
 * that collector, so the receiver must not be able to tell the difference.
 *
 * Rules carried over verbatim, because the receiver's evidence model relies on
 * them (see docs/JARVIS-LINK.md):
 *   - per-route 403/404 is refused *evidence*, not a failure
 *   - a null due date means "no date known", never "no deadline"
 *   - a refused submissions route is NOT "unsubmitted"
 *   - failure and "zero assignments" are different states
 *   - priority scores are never sent; Jarvis decides what matters
 */

import { ROUTES, failed, identifier, offering, pathFor, supported } from './routes';
import type { JarvisHost, RouteArgs, RouteName, RouteResult } from './routes';

/** `fetchedAt` is an ISO instant: the receiver parses it, not a number. */
export interface EvidenceRoute {
  route: string;
  status: number;
  fetchedAt: string;
  complete: boolean;
  body: unknown;
}

/**
 * A normal per-course batch, or a host-failure batch.
 *
 * The receiver (apps/cloud-gateway/src/school/collector-protocol.ts) accepts
 * `course: null` with `courseIds: []` and `enrollmentComplete: false` to mean
 * "this board could not be read at all". The Jarvis collector never emitted
 * that envelope — its runbook lists it as still to be built — so a board that
 * failed before any course was discovered produced silence, which reads as
 * "nothing is due". School Helper emits it.
 */
export interface ObservationBatch {
  schemaVersion: '1.0';
  host: string;
  readId: string;
  startedAt: string;
  courseIds: string[];
  enrollmentComplete: boolean;
  course: { id: string; name: string } | null;
  routes: EvidenceRoute[];
}

export interface CourseSummary {
  id: string;
  name: string;
  /** Every route was completely received and either 200 or a JSON 403. */
  normalEvidence: boolean;
  refused: number;
  read: number;
  error: string | null;
}

export interface HostResult {
  host: string;
  error: string | null;
  courses: CourseSummary[];
  /** Set only when the whole host read cleanly; otherwise null. */
  lastGoodRead: string | null;
  /** True when a host-failure envelope was emitted instead of course batches. */
  hostFailureEmitted?: boolean;
}

/** Small async key/value store, so the caller decides where state lives. */
export interface EvidenceStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface CollectOptions {
  host: JarvisHost;
  request: (host: JarvisHost, route: RouteName, args?: RouteArgs) => Promise<RouteResult>;
  store: EvidenceStore;
  emit: (batch: ObservationBatch) => Promise<{ error?: string | null }>;
  /** Returns an ISO instant. The receiver rejects numeric timestamps. */
  clock: () => string;
  readId: string;
}

export const MAX_COURSES = 128;
export const MAX_ROUTES = 256;

/**
 * Reads one board and emits one batch per course.
 *
 * A host-level failure does not abandon known courses: the last known manifest
 * is reused so the receiver still gets an explicit failure per course rather
 * than silence, which it would otherwise read as "nothing is due".
 */
export async function collectHost(options: CollectOptions): Promise<HostResult> {
  const { host, request, store, emit, clock, readId } = options;
  const startedAt = clock();
  const known = (await store.get<{ id: string; name: string }[]>(`courses:${host}`)) ?? [];
  const courses = new Map<string, { id: string; name: string }>();
  const seenBookmarks = new Set<string>();
  let error: string | undefined;
  let bookmark: string | undefined;

  // Host-level evidence, kept so a board that fails before any course is
  // discovered can still be reported explicitly rather than as silence.
  const hostRoutes: EvidenceRoute[] = [];
  const recordHostRoute = (route: RouteName, args: RouteArgs, result: RouteResult) => {
    const label = pathFor(host, route, args);
    if (hostRoutes.some((entry) => entry.route === label)) return; // receiver refuses duplicates
    hostRoutes.push({
      route: label,
      status: result.status,
      fetchedAt: clock(),
      complete: result.complete,
      body: result.body,
    });
  };

  const versions = await request(host, 'versions');
  recordHostRoute('versions', {}, versions);
  if (versions.status !== 200 || !versions.complete) error = versions.error ?? 'versions-refused';
  else if (!supported(versions.body)) error = 'required-api-version-unavailable';

  while (!error) {
    const page = await request(host, 'enrollments', { bookmark });
    recordHostRoute('enrollments', bookmark === undefined ? {} : { bookmark }, page);
    if (page.status !== 200 || !page.complete) {
      error = page.error ?? 'enrollments-refused';
      break;
    }
    const body = page.body as
      { Items?: unknown[]; PagingInfo?: { HasMoreItems?: boolean; Bookmark?: string } } | undefined;
    if (!Array.isArray(body?.Items) || typeof body?.PagingInfo?.HasMoreItems !== 'boolean') {
      error = 'enrollments-shape-unexpected';
      break;
    }
    for (const item of (body.Items as Parameters<typeof offering>[0][]).filter(offering)) {
      try {
        const orgUnit = (item as { OrgUnit: { Id: unknown; Name?: unknown } }).OrgUnit;
        const id = identifier(orgUnit.Id);
        const name = orgUnit.Name;
        if (typeof name !== 'string' || !name.trim() || name.length > 512)
          throw new Error('bad-name');
        courses.set(id, { id, name });
      } catch {
        error = 'enrollments-shape-unexpected';
      }
    }
    if (!body.PagingInfo.HasMoreItems) break;
    bookmark = body.PagingInfo.Bookmark;
    if (typeof bookmark !== 'string' || !bookmark || seenBookmarks.has(bookmark)) {
      error = 'enrollments-pagination-stopped';
      break;
    }
    seenBookmarks.add(bookmark);
  }

  if (error) for (const course of known) courses.set(course.id, course);
  const manifest = [...courses.values()];

  if (error && manifest.length === 0) {
    // Nothing is known about this board. Say so explicitly.
    const batch: ObservationBatch = {
      schemaVersion: '1.0',
      host: new URL(host).hostname,
      readId,
      startedAt,
      courseIds: [],
      enrollmentComplete: false,
      course: null,
      routes: hostRoutes.slice(0, MAX_ROUTES),
    };
    await emit(batch);
    return { host, error, courses: [], lastGoodRead: null, hostFailureEmitted: true };
  }
  if (manifest.length > MAX_COURSES) {
    return { host, error: 'course-manifest-too-large', courses: [], lastGoodRead: null };
  }
  if (!error) await store.set(`courses:${host}`, manifest);

  const summaries: CourseSummary[] = [];
  for (const course of manifest) {
    const routes: EvidenceRoute[] = [];
    const routeErrors: (string | undefined)[] = [];
    let normalEvidence = true;

    const seenLabels = new Set<string>();
    const readRoute = async (route: RouteName, args: RouteArgs = { course: course.id }) => {
      // The receiver refuses a batch containing two identical route labels, so
      // a course listing the same folder twice must not cost us the whole read.
      const label = pathFor(host, route, args);
      if (seenLabels.has(label)) return undefined;
      seenLabels.add(label);
      let result = error ? failed(0, error) : await request(host, route, args);
      const body = result.body as
        { Next?: unknown; PagingInfo?: { HasMoreItems?: boolean } } | undefined;
      if (
        result.status === 200 &&
        result.complete &&
        (body?.Next != null || body?.PagingInfo?.HasMoreItems === true)
      ) {
        result = { ...result, complete: false, error: 'tool-pagination-incomplete' };
      }
      if (
        route === 'folders' &&
        result.status === 200 &&
        result.complete &&
        !Array.isArray(result.body)
      ) {
        result = failed(result.status, 'folders-shape-unexpected');
      }
      // 200 and a JSON 403 are both normal evidence. Anything else is not.
      normalEvidence &&= result.complete && [200, 403].includes(result.status);
      routeErrors.push(result.error);
      routes.push({
        route: label,
        status: result.status,
        fetchedAt: clock(),
        complete: result.complete,
        body: result.body,
      });
      return result;
    };

    let folders: RouteResult | undefined;
    for (const route of ROUTES) {
      const result = await readRoute(route);
      if (route === 'folders') folders = result;
    }

    if (!error && folders) {
      const key = `folders:${host}:${course.id}`;
      const fresh = folders.status === 200 && folders.complete;
      if (fresh) await store.set(key, folders.body);
      const list = ((fresh ? folders.body : await store.get(key)) ?? []) as { Id?: unknown }[];
      for (const folder of list) {
        try {
          identifier(folder.Id);
        } catch {
          normalEvidence = false;
          const entry = routes.find(
            (r) => r.route === pathFor(host, 'folders', { course: course.id }),
          );
          if (entry) entry.complete = false;
          continue;
        }
        await readRoute('submissions', { course: course.id, folder: folder.Id as string });
      }
    }

    const batch: ObservationBatch = {
      schemaVersion: '1.0',
      host: new URL(host).hostname,
      readId,
      startedAt,
      courseIds: manifest.map((entry) => entry.id),
      enrollmentComplete: !error,
      course,
      routes: routes.slice(0, MAX_ROUTES),
    };
    const queued = await emit(batch);
    summaries.push({
      id: course.id,
      name: course.name,
      normalEvidence,
      refused: routes.filter((r) => r.status !== 200 || !r.complete).length,
      read: routes.filter((r) => r.status === 200 && r.complete).length,
      error: queued.error ?? error ?? routeErrors.find(Boolean) ?? null,
    });
  }

  return {
    host,
    error: error ?? null,
    courses: summaries,
    lastGoodRead: !error && summaries.every((c) => c.normalEvidence && !c.error) ? clock() : null,
  };
}
