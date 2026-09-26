import { describe, expect, it } from 'vitest';
import { collectHost } from '../src/jarvis/evidence';
import type { ObservationBatch } from '../src/jarvis/evidence';
import { classify, failed, identifier, offering, pathFor, supported } from '../src/jarvis/routes';
import type { JarvisHost, RouteArgs, RouteName, RouteResult } from '../src/jarvis/routes';
import { canonical } from '../src/jarvis/canonical';

const HOST: JarvisHost = 'https://ldsb.elearningontario.ca';

const VERSIONS = [
  { ProductCode: 'lp', SupportedVersions: ['1.43'] },
  { ProductCode: 'le', SupportedVersions: ['1.82'] },
];

const enrollment = (id: number, name: string) => ({
  Access: { CanAccess: true, IsActive: true },
  OrgUnit: { Id: id, Name: name, Type: { Id: 3 } },
});

function memoryStore() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      data.set(key, value);
    },
  };
}

interface HarnessOptions {
  routes?: Partial<Record<RouteName, RouteResult>>;
  enrollments?: unknown;
  versions?: RouteResult;
  folders?: unknown;
}

function harness(options: HarnessOptions = {}) {
  const batches: ObservationBatch[] = [];
  let tick = 1_700_000_000_000;
  const isoClock = () => new Date((tick += 1000)).toISOString();
  const request = async (_host: JarvisHost, route: RouteName, _args?: RouteArgs): Promise<RouteResult> => {
    if (route === 'versions') return options.versions ?? { status: 200, complete: true, body: VERSIONS };
    if (route === 'enrollments') {
      return {
        status: 200,
        complete: true,
        body: options.enrollments ?? { Items: [enrollment(1001, 'BBB4M0-01 International Business')], PagingInfo: { HasMoreItems: false } },
      };
    }
    if (route === 'folders') return options.routes?.folders ?? { status: 200, complete: true, body: options.folders ?? [] };
    return options.routes?.[route] ?? { status: 200, complete: true, body: [] };
  };
  return {
    batches,
    run: () =>
      collectHost({
        host: HOST,
        request,
        store: memoryStore(),
        clock: isoClock,
        readId: 'read-1',
        emit: async (batch) => {
          batches.push(batch);
          return { error: null };
        },
      }),
  };
}

describe('route contract', () => {
  it('builds the collector route labels exactly', () => {
    expect(pathFor(HOST, 'items', { course: 1001 })).toBe('/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=1001');
    expect(pathFor(HOST, 'submissions', { course: 1001, folder: 7 })).toBe(
      '/d2l/api/le/1.82/1001/dropbox/folders/7/submissions/mysubmissions/',
    );
  });

  it('refuses to interpolate a non-numeric id', () => {
    expect(() => identifier('1001; DROP')).toThrow('invalid-identifier');
    expect(() => pathFor(HOST, 'toc', { course: '../../admin' })).toThrow();
  });

  it('requires both LP 1.43 and LE 1.82', () => {
    expect(supported(VERSIONS)).toBe(true);
    expect(supported([{ ProductCode: 'lp', SupportedVersions: ['1.43'] }])).toBe(false);
  });

  it('reads only active, accessible course offerings', () => {
    expect(offering(enrollment(1, 'x'))).toBe(true);
    expect(offering({ Access: { CanAccess: false, IsActive: true }, OrgUnit: { Type: { Id: 3 } } })).toBe(false);
    expect(offering({ Access: { CanAccess: true, IsActive: true }, OrgUnit: { Type: { Id: 2 } } })).toBe(false);
  });
});

describe('the evidence rules carried over from the Jarvis collector', () => {
  it('RULE: a JSON 403 is refused evidence, complete and retained — not a failure', () => {
    const result = classify(403, 'application/json', false, () => ({ Errors: ['no permission'] }));
    expect(result.complete).toBe(true);
    expect(result.status).toBe(403);
    expect(result.error).toBeUndefined();
    expect(result.body).toEqual({ Errors: ['no permission'] });
  });

  it('RULE: a 404 from an optional tool is retained as evidence, not a session failure', () => {
    const result = classify(404, 'application/json', false, () => ({ Errors: ['not found'] }));
    expect(result.complete).toBe(true);
    expect(result.status).toBe(404);
  });

  it('RULE: an HTML 200 login page is a session failure, never an empty course', () => {
    const result = classify(200, 'text/html', false, () => ({}));
    expect(result.complete).toBe(false);
    expect(result.error).toBe('session-expired');
    expect(result.body).toEqual({ collectorFailure: 'session-expired' });
  });

  it('RULE: a redirect and a 401 are session failures', () => {
    expect(classify(302, 'application/json', true, () => ({})).error).toBe('session-expired');
    expect(classify(401, 'application/json', false, () => ({})).error).toBe('session-expired');
  });

  it('RULE: a refused submissions route is NOT recorded as unsubmitted', async () => {
    const h = harness({
      folders: [{ Id: 7 }],
      routes: { submissions: { status: 403, complete: true, body: { Errors: ['refused'] } } },
    });
    await h.run();
    const submissions = h.batches[0].routes.find((r) => r.route.includes('mysubmissions'));
    expect(submissions).toBeDefined();
    expect(submissions!.status).toBe(403);
    expect(submissions!.complete).toBe(true);
    // The evidence carries the refusal itself. Nothing in the batch claims the
    // work was not handed in.
    expect(JSON.stringify(submissions!.body)).not.toMatch(/unsubmitted|notSubmitted/i);
  });

  it('RULE: a null due date is sent through untouched, meaning "no date known"', async () => {
    const h = harness({ routes: { items: { status: 200, complete: true, body: [{ Id: 5, Title: 'Essay', DueDate: null }] } } });
    await h.run();
    const items = h.batches[0].routes.find((r) => r.route.includes('myItems'));
    expect((items!.body as { DueDate: null }[])[0].DueDate).toBeNull();
    // Not coerced to a far-future or epoch date anywhere on the wire.
    expect(canonical(items!.body)).toContain('"DueDate":null');
  });

  it('RULE: failure and zero assignments are different states', async () => {
    const empty = harness({ routes: { items: { status: 200, complete: true, body: [] } } });
    await empty.run();
    const emptyRoute = empty.batches[0].routes.find((r) => r.route.includes('myItems'))!;
    expect(emptyRoute.status).toBe(200);
    expect(emptyRoute.complete).toBe(true);
    expect(emptyRoute.body).toEqual([]);

    const broken = harness({ routes: { items: failed(0, 'network-or-timeout') } });
    await broken.run();
    const brokenRoute = broken.batches[0].routes.find((r) => r.route.includes('myItems'))!;
    expect(brokenRoute.complete).toBe(false);
    expect(brokenRoute.body).toEqual({ collectorFailure: 'network-or-timeout' });
  });

  it('marks a paginated tool response incomplete rather than claiming the whole list', async () => {
    const h = harness({ routes: { quizzes: { status: 200, complete: true, body: { PagingInfo: { HasMoreItems: true } } } } });
    await h.run();
    const quizzes = h.batches[0].routes.find((r) => r.route.endsWith('/quizzes/'))!;
    expect(quizzes.complete).toBe(false);
  });

  it('treats a non-array folders body as a shape failure', async () => {
    const h = harness({ routes: { folders: { status: 200, complete: true, body: { nope: true } } } });
    await h.run();
    const folders = h.batches[0].routes.find((r) => r.route.endsWith('/dropbox/folders/'))!;
    expect(folders.complete).toBe(false);
    expect(folders.body).toEqual({ collectorFailure: 'folders-shape-unexpected' });
  });

  it('emits one batch per course, each carrying the full course manifest', async () => {
    const h = harness({
      enrollments: {
        Items: [enrollment(1001, 'BBB4M0-01'), enrollment(1002, 'CIA4U-01')],
        PagingInfo: { HasMoreItems: false },
      },
    });
    await h.run();
    expect(h.batches).toHaveLength(2);
    expect(h.batches[0].courseIds).toEqual(['1001', '1002']);
    expect(h.batches[0].enrollmentComplete).toBe(true);
    expect(h.batches[0].host).toBe('ldsb.elearningontario.ca');
    expect(h.batches[0].schemaVersion).toBe('1.0');
  });

  it('still reports per-course failure batches when enrollments fail and courses are known', async () => {
    const store = memoryStore();
    await store.set(`courses:${HOST}`, [{ id: '1001', name: 'BBB4M0-01' }]);
    const batches: ObservationBatch[] = [];
    const result = await collectHost({
      host: HOST,
      request: async (_h, route) =>
        route === 'versions' ? { status: 200, complete: true, body: VERSIONS } : failed(0, 'network-or-timeout'),
      store,
      clock: () => '2026-09-26T12:00:00.000Z',
      readId: 'read-2',
      emit: async (batch) => {
        batches.push(batch);
        return { error: null };
      },
    });
    // Silence would read to Jarvis as "nothing is due". An explicit failure does not.
    expect(batches).toHaveLength(1);
    expect(batches[0].enrollmentComplete).toBe(false);
    expect(batches[0].routes.every((r) => !r.complete)).toBe(true);
    expect(result.lastGoodRead).toBeNull();
    expect(result.error).toBe('network-or-timeout');
  });

  it('fails loudly when the required API versions are missing', async () => {
    const h = harness({ versions: { status: 200, complete: true, body: [{ ProductCode: 'lp', SupportedVersions: ['1.0'] }] } });
    const result = await h.run();
    expect(result.error).toBe('required-api-version-unavailable');
  });

  it('records a clean host read only when every course had normal evidence', async () => {
    const clean = await harness().run();
    expect(clean.lastGoodRead).not.toBeNull();
    const dirty = await harness({ routes: { news: failed(0, 'network-or-timeout') } }).run();
    expect(dirty.lastGoodRead).toBeNull();
  });
});

describe('what is NOT on the wire', () => {
  it('sends no priority score, weekend plan or "what next" ranking', async () => {
    const h = harness({
      routes: { items: { status: 200, complete: true, body: [{ Id: 5, Title: 'Essay', DueDate: '2026-10-01T03:59:00.000Z' }] } },
    });
    await h.run();
    const wire = canonical(h.batches[0]);
    for (const banned of ['priority', 'priorityScore', 'bucket', 'weekendPlan', 'whatNext', 'score']) {
      expect(wire).not.toContain(banned);
    }
  });

  it('sends raw D2L bodies, not School Helper WorkItems', async () => {
    const h = harness({ routes: { items: { status: 200, complete: true, body: [{ Id: 5, Title: 'Essay' }] } } });
    await h.run();
    const wire = canonical(h.batches[0]);
    // WorkItem-only fields must never appear.
    for (const banned of ['overrides', 'presentInLastSync', 'firstSeenAt', 'hiddenFromList']) {
      expect(wire).not.toContain(banned);
    }
    expect(wire).toContain('"Title":"Essay"');
  });
});
