/**
 * Validates our batches against the receiver's real acceptance rules.
 *
 * `assertAcceptable` is a faithful transcription of `parseSchoolBatch` in
 * apps/cloud-gateway/src/school/collector-protocol.ts (stremysid/jarvis, read
 * at commit 0c56920). It is deliberately strict — exact field sets, the route
 * allow-list, ISO instants, no duplicate routes — so that if School Helper ever
 * drifts from the contract, this fails here instead of in production.
 *
 * It is a transcription, not the receiver itself. Only a live push proves
 * acceptance. See KNOWN_ISSUES.md #16.
 */

import { describe, expect, it } from 'vitest';
import { collectHost } from '../src/jarvis/evidence';
import type { ObservationBatch } from '../src/jarvis/evidence';
import { canonical } from '../src/jarvis/canonical';
import { failed } from '../src/jarvis/routes';
import type { JarvisHost, RouteName, RouteResult } from '../src/jarvis/routes';

const SCHOOL_HOSTS = ['ldsb.elearningontario.ca', 'durham.elearningontario.ca'];
const BODY_LIMIT = 65_536;

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('school_object_invalid');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(',') !== [...fields].sort().join(',')) {
    throw new Error(`school_fields_invalid: got ${Object.keys(result).sort().join(',')}`);
  }
  return result;
}

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label);
  return value;
}

function identifier(value: unknown): string {
  const result = requireText(value, 'school_id', 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error('school_id_invalid');
  return result;
}

function requireInstant(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(label);
  }
  return value;
}

/** Throws exactly where the receiver would throw. */
export function assertAcceptable(value: unknown, now = new Date()): void {
  if (new TextEncoder().encode(canonical(value)).length >= BODY_LIMIT) throw new Error('school_batch_too_large');
  const root = exact(value, ['schemaVersion', 'host', 'readId', 'startedAt', 'courseIds', 'enrollmentComplete', 'course', 'routes']);
  if (root.schemaVersion !== '1.0' || !SCHOOL_HOSTS.includes(root.host as string)) throw new Error('school_source_invalid');
  identifier(root.readId);
  const startedAt = requireInstant(root.startedAt, 'school_started_at');
  if (Date.parse(startedAt) > now.getTime()) throw new Error('school_time_future');

  const hostFailure = root.course === null;
  const course = hostFailure ? null : exact(root.course, ['id', 'name']);
  const courseId = course === null ? null : identifier(course.id);
  if (course !== null) requireText(course.name, 'school_course_name', 512);

  const courseIds = root.courseIds as string[];
  if (
    !Array.isArray(courseIds) ||
    courseIds.length > 128 ||
    courseIds.some((id) => identifier(id) !== id) ||
    new Set(courseIds).size !== courseIds.length ||
    (hostFailure ? courseIds.length !== 0 || root.enrollmentComplete !== false : !courseIds.includes(courseId!)) ||
    typeof root.enrollmentComplete !== 'boolean'
  ) {
    throw new Error('school_manifest_invalid');
  }

  const routes = root.routes as unknown[];
  if (!Array.isArray(routes) || routes.length > 256 || (hostFailure && routes.length === 0)) throw new Error('school_routes_invalid');

  const prefix = `/d2l/api/le/1.82/${courseId}/`;
  const myItemsPath = '/d2l/api/le/1.82/content/myItems/';
  const seen = new Set<string>();
  for (const entry of routes) {
    const route = exact(entry, ['route', 'status', 'fetchedAt', 'complete', 'body']);
    if (typeof route.route !== 'string' || !route.route.startsWith('/d2l/api/') || route.route.includes('#')) {
      throw new Error('school_route_invalid');
    }
    const url = new URL(route.route, `https://${root.host}`);
    const orgUnitIds = url.searchParams.getAll('orgUnitIdsCSV');
    const isMyItems = url.pathname === myItemsPath && orgUnitIds.length === 1 && orgUnitIds[0] === courseId;
    const isQuizzes = url.pathname === `${prefix}quizzes/`;
    const isEnrollments = url.pathname === '/d2l/api/lp/1.43/enrollments/myenrollments/';
    const isEnrollmentBookmark = hostFailure && isEnrollments && url.searchParams.size === 1 && url.searchParams.has('bookmark');
    const allowed = hostFailure
      ? ['/d2l/api/versions/', '/d2l/api/lp/1.43/enrollments/myenrollments/'].includes(url.pathname)
      : isMyItems ||
        (url.pathname.startsWith(prefix) &&
          /^(dropbox\/folders\/|dropbox\/folders\/[a-zA-Z0-9_-]+\/submissions\/mysubmissions\/|content\/toc|grades\/values\/myGradeValues\/|news\/|quizzes\/)$/.test(
            url.pathname.slice(prefix.length),
          ));
    if (
      route.route !== url.pathname + url.search ||
      !allowed ||
      (url.search !== '' && !isMyItems && !isQuizzes && !isEnrollmentBookmark) ||
      seen.has(route.route)
    ) {
      throw new Error(`school_route_invalid: ${route.route}`);
    }
    seen.add(route.route);
    if (
      !Number.isInteger(route.status) ||
      !(route.status === 0 || (Number(route.status) >= 100 && Number(route.status) <= 599)) ||
      typeof route.complete !== 'boolean'
    ) {
      throw new Error('school_route_status_invalid');
    }
    const at = requireInstant(route.fetchedAt, 'school_fetched_at');
    if (at < startedAt || Date.parse(at) > now.getTime()) throw new Error('school_time_invalid');
  }
}

const VERSIONS = [
  { ProductCode: 'lp', SupportedVersions: ['1.43'] },
  { ProductCode: 'le', SupportedVersions: ['1.82'] },
];

function memoryStore() {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      data.set(key, value);
    },
  };
}

interface RunOptions {
  host?: JarvisHost;
  routes?: Partial<Record<RouteName, RouteResult>>;
  folders?: unknown;
  courses?: { Id: number; Name: string }[];
  knownCourses?: { id: string; name: string }[];
}

async function run(options: RunOptions = {}) {
  const batches: ObservationBatch[] = [];
  let tick = Date.parse('2026-09-26T12:00:00.000Z');
  const store = memoryStore();
  if (options.knownCourses) await store.set(`courses:${options.host ?? 'https://ldsb.elearningontario.ca'}`, options.knownCourses);
  await collectHost({
    host: options.host ?? 'https://ldsb.elearningontario.ca',
    store,
    clock: () => new Date((tick += 1000)).toISOString(),
    readId: '1758888000000-ab12cd',
    request: async (_h, route) => {
      if (options.routes?.[route]) return options.routes[route]!;
      if (route === 'versions') return { status: 200, complete: true, body: VERSIONS };
      if (route === 'enrollments') {
        return {
          status: 200,
          complete: true,
          body: {
            Items: (options.courses ?? [{ Id: 1001, Name: 'BBB4M0-01 International Business' }]).map((c) => ({
              Access: { CanAccess: true, IsActive: true },
              OrgUnit: { Id: c.Id, Name: c.Name, Type: { Id: 3 } },
            })),
            PagingInfo: { HasMoreItems: false },
          },
        };
      }
      if (route === 'folders') return { status: 200, complete: true, body: options.folders ?? [] };
      return { status: 200, complete: true, body: [] };
    },
    emit: async (batch) => {
      batches.push(batch);
      return { error: null };
    },
  });
  return batches;
}

const later = new Date('2026-09-27T00:00:00.000Z');

describe('every batch School Helper produces is acceptable to the receiver', () => {
  it('a normal course batch passes the receiver parser', async () => {
    const [batch] = await run();
    expect(() => assertAcceptable(batch, later)).not.toThrow();
  });

  it('every route label is on the receiver allow-list, including submissions', async () => {
    const [batch] = await run({ folders: [{ Id: 77 }, { Id: 78 }] });
    expect(() => assertAcceptable(batch, later)).not.toThrow();
    expect(batch.routes.map((r) => r.route)).toContain('/d2l/api/le/1.82/1001/dropbox/folders/77/submissions/mysubmissions/');
  });

  it('the myItems query string is exactly the one the receiver expects', async () => {
    const [batch] = await run();
    const myItems = batch.routes.find((r) => r.route.includes('myItems'))!;
    expect(myItems.route).toBe('/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=1001');
    expect(() => assertAcceptable(batch, later)).not.toThrow();
  });

  it('a refused (403) route batch is still acceptable', async () => {
    const [batch] = await run({ routes: { grades: { status: 403, complete: true, body: { Errors: ['no'] } } } });
    expect(() => assertAcceptable(batch, later)).not.toThrow();
  });

  it('a batch full of failures is still acceptable', async () => {
    const [batch] = await run({
      routes: {
        items: failed(0, 'network-or-timeout'),
        toc: failed(0, 'network-or-timeout'),
        grades: failed(0, 'network-or-timeout'),
      },
    });
    expect(() => assertAcceptable(batch, later)).not.toThrow();
  });

  it('the HOST-FAILURE envelope is acceptable: course null, no courseIds, versions/enrollments only', async () => {
    const batches = await run({ routes: { versions: failed(0, 'network-or-timeout') } });
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch.course).toBeNull();
    expect(batch.courseIds).toEqual([]);
    expect(batch.enrollmentComplete).toBe(false);
    expect(batch.routes.length).toBeGreaterThan(0);
    expect(() => assertAcceptable(batch, later)).not.toThrow();
  });

  it('timestamps are ISO instants, and fetchedAt never precedes startedAt', async () => {
    const [batch] = await run({ folders: [{ Id: 77 }] });
    expect(batch.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    for (const route of batch.routes) {
      expect(route.fetchedAt >= batch.startedAt).toBe(true);
    }
  });

  it('no duplicate route labels, which the receiver refuses', async () => {
    const [batch] = await run({ folders: [{ Id: 77 }, { Id: 77 }] });
    const labels = batch.routes.map((r) => r.route);
    // A duplicated folder id must not yield a duplicated route label.
    expect(new Set(labels).size).toBe(labels.length);
    expect(() => assertAcceptable(batch, later)).not.toThrow();
  });

  it('every batch fits the 64 KiB canonical body limit or is a compact failure', async () => {
    const batches = await run({ courses: [{ Id: 1001, Name: 'BBB4M0-01' }, { Id: 1002, Name: 'CIA4U-01' }] });
    for (const batch of batches) {
      expect(new TextEncoder().encode(canonical(batch)).length).toBeLessThan(65536);
    }
  });

  it('the receiver transcription actually rejects bad batches', async () => {
    const [batch] = await run();
    expect(() => assertAcceptable({ ...batch, startedAt: 1_700_000_000_000 }, later)).toThrow('school_started_at');
    expect(() => assertAcceptable({ ...batch, host: 'evil.example.com' }, later)).toThrow('school_source_invalid');
    expect(() => assertAcceptable({ ...batch, extra: 1 }, later)).toThrow(/school_fields_invalid/);
    expect(() => assertAcceptable({ ...batch, courseIds: [] }, later)).toThrow('school_manifest_invalid');
    expect(() =>
      assertAcceptable({ ...batch, routes: [{ ...batch.routes[0], route: '/d2l/api/le/1.82/1001/admin/' }] }, later),
    ).toThrow(/school_route_invalid/);
  });
});
