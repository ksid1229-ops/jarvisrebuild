import { assertReadOnly, assertSafePath, endpoints, API_VERSIONS } from './endpoints';
import type { BoardId } from '../common/types';
import { BOARDS } from '../common/settings';

export interface RequestLogEntry {
  url: string;
  status: number;
  ms: number;
}

export interface D2lClientOptions {
  /** Injected so tests can drive the client without a network. */
  fetchImpl?: typeof fetch;
  onRequest?: (entry: RequestLogEntry) => void;
  onBody?: (
    endpointName: string,
    url: string,
    status: number,
    body: string,
  ) => void | Promise<void>;
}

export class D2lError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'D2lError';
  }
}

/**
 * Same-origin, cookie-authenticated, GET-only D2L reader.
 * It piggybacks on the session the user already has in the browser —
 * it never sees, asks for, or stores a password.
 */
export class D2lClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private versions: { lp: string; le: string } = { ...API_VERSIONS };
  private versionsNegotiated = false;

  constructor(
    readonly board: BoardId,
    private readonly opts: D2lClientOptions = {},
  ) {
    this.origin = BOARDS[board].origin;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get apiVersions() {
    return { ...this.versions };
  }

  private url(path: string): string {
    return path.startsWith('http') ? path : `${this.origin}${path}`;
  }

  async getJson<T>(path: string, endpointName = 'unknown'): Promise<T> {
    const text = await this.getText(path, endpointName);
    try {
      return JSON.parse(text) as T;
    } catch {
      // A login redirect returns HTML with a 200 — detect it and say so plainly.
      if (/<html/i.test(text)) {
        throw new D2lError(
          `Got an HTML page instead of JSON — your ${BOARDS[this.board].label} session has probably expired. Open the site in a tab and log in, then sync again.`,
          200,
          this.url(path),
        );
      }
      throw new D2lError('Response was not valid JSON.', 200, this.url(path));
    }
  }

  async getText(path: string, endpointName = 'unknown'): Promise<string> {
    const url = this.url(path);
    assertReadOnly('GET');
    assertSafePath(url);

    const started = performance.now();
    const res = await this.fetchImpl(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      headers: { Accept: 'application/json, text/html;q=0.8' },
    });
    const ms = Math.round(performance.now() - started);
    this.opts.onRequest?.({ url: redactUrl(url), status: res.status, ms });

    const body = await res.text();
    await this.opts.onBody?.(endpointName, url, res.status, body);

    if (res.status === 401 || res.status === 403) {
      throw new D2lError(
        `Not authorised (${res.status}). Open ${BOARDS[this.board].label} in a tab, make sure you're logged in, then sync again.`,
        res.status,
        url,
      );
    }
    if (res.status === 404) throw new D2lError('Not found (404).', 404, url);
    if (!res.ok) throw new D2lError(`Request failed (${res.status}).`, res.status, url);
    return body;
  }

  /** Optional read; a 404/403 on one course resource must not kill the whole sync. */
  async tryGetJson<T>(path: string, endpointName = 'unknown'): Promise<T | null> {
    try {
      return await this.getJson<T>(path, endpointName);
    } catch (err) {
      if (err instanceof D2lError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  }

  /**
   * Ask the tenant which API versions it supports and pin to the highest
   * supported version at or below what we were written against.
   */
  async negotiateVersions(): Promise<{ lp: string; le: string }> {
    if (this.versionsNegotiated) return this.versions;
    const supported = await this.tryGetJson<ProductVersions[]>(endpoints.versions(), 'versions');
    if (supported) {
      for (const product of supported) {
        const key = product.ProductCode?.toLowerCase();
        if (key !== 'lp' && key !== 'le') continue;
        const want = API_VERSIONS[key];
        const best = pickVersion(product.SupportedVersions ?? [], want);
        if (best) this.versions[key] = best;
      }
    }
    this.versionsNegotiated = true;
    return this.versions;
  }
}

export interface ProductVersions {
  ProductCode: string;
  LatestVersion?: string;
  SupportedVersions?: string[];
}

/** Highest supported version that is <= the version we target. */
export function pickVersion(supported: string[], want: string): string | null {
  const cmp = (a: string, b: string) => {
    const [a1, a2] = a.split('.').map(Number);
    const [b1, b2] = b.split('.').map(Number);
    return a1 - b1 || (a2 || 0) - (b2 || 0);
  };
  const ok = supported.filter((v) => /^\d+\.\d+$/.test(v) && cmp(v, want) <= 0).sort(cmp);
  if (ok.length) return ok[ok.length - 1];
  const any = supported.filter((v) => /^\d+\.\d+$/.test(v)).sort(cmp);
  return any.length ? any[0] : null;
}

/** Strip ids and tokens from URLs before they reach a log. */
export function redactUrl(url: string): string {
  return url
    .replace(/([?&])(token|x-a|x-b|x-c|x-d|x-t|sessionid)=[^&]*/gi, '$1$2=REDACTED')
    .replace(/\/users\/\d+/g, '/users/REDACTED');
}
