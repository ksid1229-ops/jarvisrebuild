/**
 * The Jarvis collector's D2L route contract.
 *
 * Ported from apps/d2l-extension/probe.js in stremysid/jarvis. School Helper
 * replaces that collector, so the evidence it sends has to be shaped by the
 * same rules. The receiver's evidence model depends on these distinctions:
 *
 *  - A JSON 403 is a **fully observed refusal** (`complete: true`), never an
 *    empty success and never a failure.
 *  - A redirect, a non-JSON body (including a 200 login page) or a 401 is a
 *    **session failure**, never evidence about the course.
 *  - `complete` describes receipt and paging, not permission.
 */

import type { BoardId } from '../common/types';

export const HOSTS = Object.freeze([
  'https://ldsb.elearningontario.ca',
  'https://durham.elearningontario.ca',
] as const);

export type JarvisHost = (typeof HOSTS)[number];

export const BOARD_HOST: Record<BoardId, JarvisHost> = {
  ldsb: 'https://ldsb.elearningontario.ca',
  durham: 'https://durham.elearningontario.ca',
};

/** Routes read for every course, in this order. */
export const ROUTES = Object.freeze([
  'items',
  'toc',
  'folders',
  'gradeObjects',
  'grades',
  'news',
  'quizzes',
] as const);

export type RouteName = keyof typeof LABELS;

export const LABELS = Object.freeze({
  versions: '/d2l/api/versions/',
  enrollments: '/d2l/api/lp/1.43/enrollments/myenrollments/',
  items: '/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=<course>',
  toc: '/d2l/api/le/1.82/<course>/content/toc',
  folders: '/d2l/api/le/1.82/<course>/dropbox/folders/',
  submissions: '/d2l/api/le/1.82/<course>/dropbox/folders/<folder>/submissions/mysubmissions/',
  gradeObjects: '/d2l/api/le/1.82/<course>/grades/',
  grades: '/d2l/api/le/1.82/<course>/grades/values/myGradeValues/',
  news: '/d2l/api/le/1.82/<course>/news/',
  quizzes: '/d2l/api/le/1.82/<course>/quizzes/',
});

export interface RouteArgs {
  course?: string | number;
  folder?: string | number;
  bookmark?: string;
}

/** D2L ids are digit strings. Anything else is refused rather than interpolated. */
export function identifier(value: unknown): string {
  if (!/^[0-9]{1,20}$/.test(String(value))) throw new Error('invalid-identifier');
  return String(value);
}

export function routeUrl(host: string, route: RouteName, args: RouteArgs = {}): string {
  if (!(HOSTS as readonly string[]).includes(host)) throw new Error('invalid-host');
  if (!Object.hasOwn(LABELS, route)) throw new Error('invalid-route');
  let path: string = LABELS[route];
  if (path.includes('<course>')) path = path.replace('<course>', identifier(args.course));
  if (path.includes('<folder>')) path = path.replace('<folder>', identifier(args.folder));
  const url = new URL(path, host);
  if (route === 'enrollments' && args.bookmark !== undefined)
    url.searchParams.set('bookmark', args.bookmark);
  return url.href;
}

/** The route label recorded in evidence: the path, host stripped. */
export function pathFor(host: string, route: RouteName, args: RouteArgs = {}): string {
  return routeUrl(host, route, args).slice(host.length);
}

export interface RouteResult {
  status: number;
  complete: boolean;
  body: unknown;
  error?: string;
}

export const failed = (status: number, error: string): RouteResult => ({
  status,
  complete: false,
  body: { collectorFailure: error },
  error,
});

/**
 * Classify a response into the receiver's evidence model. Kept separate from
 * fetching so it can be tested without a network.
 */
export function classify(
  status: number,
  contentType: string | null,
  redirected: boolean,
  parse: () => unknown,
): RouteResult {
  if (status === 0 || redirected || (status >= 300 && status < 400))
    return failed(status, 'session-expired');
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType ?? ''))
    return failed(status, 'session-expired');
  let body: unknown;
  try {
    body = parse();
  } catch {
    return failed(status, 'session-expired');
  }
  if (status === 401) return failed(401, 'session-expired');
  // A JSON 403 is a fully observed refusal. Keep the body, keep complete:true.
  return { status, complete: true, body };
}

/** True when the result means the D2L session needs renewing. */
export const needsSession = (result: RouteResult): boolean =>
  result.error === 'session-expired' || result.status === 403;

/** LP 1.43 and LE 1.82 must both be advertised, or the read fails loudly. */
export function supported(body: unknown): boolean {
  return (
    Array.isArray(body) &&
    (
      [
        ['lp', '1.43'],
        ['le', '1.82'],
      ] as const
    ).every(([product, version]) =>
      body.some(
        (item: { ProductCode?: string; SupportedVersions?: unknown }) =>
          item?.ProductCode === product &&
          Array.isArray(item.SupportedVersions) &&
          item.SupportedVersions.includes(version),
      ),
    )
  );
}

/** Only active, accessible course offerings (OrgUnit type 3) are read. */
export function offering(item: {
  Access?: { CanAccess?: boolean; IsActive?: boolean };
  OrgUnit?: { Type?: { Id?: number } };
}): boolean {
  return (
    item?.Access?.CanAccess === true &&
    item.Access.IsActive === true &&
    item.OrgUnit?.Type?.Id === 3
  );
}
