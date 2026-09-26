/**
 * The GET-only D2L reader used to build Jarvis evidence.
 *
 * This is a second read path alongside `src/d2l/client.ts`, because the
 * receiver's evidence contract is defined in terms of the collector's exact
 * route list and its raw response bodies — not School Helper's parsed
 * WorkItems. Both paths obey the same non-negotiable rule: GET only.
 *
 * The method is a hard-coded literal here. There is no parameter that could
 * ever make this issue a POST, and `tests/jarvis.reader.test.ts` asserts it.
 */

import { classify, failed, routeUrl } from './routes';
import type { JarvisHost, RouteArgs, RouteName, RouteResult } from './routes';

export const READ_TIMEOUT_MS = 15000;
/** D2L is rate-sensitive; the collector spaces requests about a second apart. */
export const REQUEST_SPACING_MS = 1000;

export interface ReaderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injected so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
}

export function makeReader(options: ReaderOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const spacing = options.spacingMs ?? REQUEST_SPACING_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = 0;

  return async function read(
    host: JarvisHost,
    route: RouteName,
    args: RouteArgs = {},
  ): Promise<RouteResult> {
    const wait = last + spacing - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();

    let url: string;
    try {
      url = routeUrl(host, route, args);
    } catch (error) {
      return failed(0, (error as Error).message);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', // never anything else
        credentials: 'include',
        redirect: 'manual',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return failed(0, 'network-or-timeout');
    }

    const text = await response.text().catch(() => '');
    return classify(
      response.status,
      response.headers.get('content-type'),
      response.redirected,
      () => JSON.parse(text),
    );
  };
}
