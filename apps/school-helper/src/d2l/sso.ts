import { BOARDS } from '../common/settings';
import { D2lClient } from './client';
import { endpoints } from './endpoints';

/**
 * LDSB → Durham single sign-on.
 *
 * Durham's D2L tenant is reached through the "My Courses in Other Boards"
 * widget on the LDSB homepage. Hitting durham.elearningontario.ca cold returns
 * a login page; following the widget link first sets the Durham session cookie.
 *
 * This is all GET navigation with `credentials: 'include'` — no credentials are
 * read, typed, or stored by the extension at any point.
 */

export interface SsoResult {
  ok: boolean;
  via: 'already-authenticated' | 'widget-link' | 'failed';
  linkUsed?: string;
  message: string;
}

/** Candidate patterns for the cross-board launch link on the LDSB homepage. */
const WIDGET_LINK_PATTERNS = [
  /href\s*=\s*["']([^"']*(?:remoteplugin|externallearningtools|lti\/launch)[^"']*)["']/gi,
  /href\s*=\s*["']([^"']*durham[^"']*)["']/gi,
  /href\s*=\s*["']([^"']*\/d2l\/lp\/auth\/[^"']*)["']/gi,
];

export function findCrossBoardLinks(html: string, origin: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const re of WIDGET_LINK_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const raw = decodeHtml(m[1]);
      const url = raw.startsWith('http') ? raw : `${origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
      if (seen.has(url)) continue;
      seen.add(url);
      found.push(url);
    }
  }
  // Prefer links that obviously point at the other board.
  return found.sort((a, b) => Number(/durham/i.test(b)) - Number(/durham/i.test(a)));
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Ensure we have a live Durham session.
 * 1. Try Durham's whoami directly — usually the cookie is still good.
 * 2. If not, load the LDSB homepage, find the cross-board link, GET it (which
 *    performs the SSO redirect chain), then retry whoami.
 */
export async function ensureDurhamSession(
  ldsb: D2lClient,
  durham: D2lClient,
  log: (msg: string) => void = () => {},
): Promise<SsoResult> {
  const probe = await safeWhoAmI(durham);
  if (probe) {
    return { ok: true, via: 'already-authenticated', message: 'Durham session already active.' };
  }

  log('Durham session not active — following the LDSB cross-board link.');

  let homepage: string;
  try {
    homepage = await ldsb.getText(endpoints.homepage(), 'homepage');
  } catch (err) {
    return {
      ok: false,
      via: 'failed',
      message: `Could not load the LDSB homepage to find the SSO link: ${(err as Error).message}`,
    };
  }

  const links = findCrossBoardLinks(homepage, BOARDS.ldsb.origin);
  if (!links.length) {
    return {
      ok: false,
      via: 'failed',
      message:
        'Could not find the "My Courses in Other Boards" link on the LDSB homepage. Open Durham D2L in a tab once, then sync again.',
    };
  }

  for (const link of links.slice(0, 4)) {
    try {
      await ldsb.getText(link, 'sso-launch');
    } catch {
      continue; // a redirect that ends somewhere unexpected is fine; the cookie may still be set
    }
    const after = await safeWhoAmI(durham);
    if (after) {
      log(`Durham session established via ${link}`);
      return {
        ok: true,
        via: 'widget-link',
        linkUsed: link,
        message: 'Durham session established via SSO.',
      };
    }
  }

  return {
    ok: false,
    via: 'failed',
    message:
      'Followed the cross-board links but Durham still rejected the session. Open durham.elearningontario.ca in a tab, click through from the LDSB homepage widget, then press Sync again.',
  };
}

async function safeWhoAmI(client: D2lClient): Promise<boolean> {
  try {
    const me = await client.getJson<{ Identifier?: string }>(endpoints.whoAmI(), 'whoami');
    return !!me?.Identifier;
  } catch {
    return false;
  }
}
