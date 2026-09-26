import { getSettings } from '../common/db';

/**
 * Google OAuth for the Docs API.
 *
 * The user creates their own OAuth client ID (README has the steps) and pastes
 * it into Settings. We use chrome.identity.launchWebAuthFlow with PKCE so no
 * client secret is ever needed or stored.
 *
 * Scope is `drive.file` + `documents`: the extension can only touch documents
 * the user explicitly opens through it, not their whole Drive.
 */

export const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
];

const TOKEN_KEY = 'school-helper.google-token';

interface StoredToken {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  scope: string;
}

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    readonly fixable: boolean = true,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

function redirectUri(): string {
  // https://<extension-id>.chromiumapp.org/ — works in Chrome and Opera GX.
  return chrome.identity.getRedirectURL('google');
}

export function expectedRedirectUri(): string {
  try {
    return redirectUri();
  } catch {
    return 'chrome.identity.getRedirectURL("google") — open the dashboard in the extension to see the exact value';
  }
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(bytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signIn(interactive = true): Promise<string> {
  const settings = await getSettings();
  const clientId = settings.google.clientId.trim();
  if (!clientId) {
    throw new GoogleAuthError(
      'No Google OAuth client ID saved. Follow the "Google setup" steps in the README, then paste your client ID into Settings.',
    );
  }

  const cached = await cachedToken();
  if (cached) return cached;

  const { verifier, challenge } = await pkcePair();
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri());
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  const redirected = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive,
  });
  if (!redirected) throw new GoogleAuthError('Google sign-in was cancelled.');

  const code = new URL(redirected).searchParams.get('code');
  if (!code)
    throw new GoogleAuthError(`Google did not return an authorisation code: ${redirected}`);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) {
    throw new GoogleAuthError(
      `Token exchange failed (${res.status}). Check the client ID type is "Chrome extension" or "Web application" with the right redirect URI.`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    scope: string;
  };
  await storeToken({
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    refreshToken: json.refresh_token,
    scope: json.scope,
  });
  return json.access_token;
}

async function cachedToken(): Promise<string | null> {
  const got = await chrome.storage.local.get(TOKEN_KEY);
  const token = got[TOKEN_KEY] as StoredToken | undefined;
  if (!token) return null;
  if (token.expiresAt > Date.now()) return token.accessToken;
  if (token.refreshToken) {
    const refreshed = await refresh(token.refreshToken);
    if (refreshed) return refreshed;
  }
  await chrome.storage.local.remove(TOKEN_KEY);
  return null;
}

async function refresh(refreshToken: string): Promise<string | null> {
  const settings = await getSettings();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.google.clientId.trim(),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token: string; expires_in: number; scope: string };
  await storeToken({
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    refreshToken,
    scope: json.scope,
  });
  return json.access_token;
}

async function storeToken(token: StoredToken): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export async function signOut(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_KEY);
}

export async function isSignedIn(): Promise<boolean> {
  return (await cachedToken()) !== null;
}

/** Extract a document id from any Google Docs URL the user pastes. */
export function docIdFromUrl(url: string): string | null {
  const m = /docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/.exec(url);
  return m ? m[1] : null;
}

/** Rebuild a doc URL against a specific Google account slot (/u/0 or /u/1). */
export function docUrlForAccount(docId: string, accountSlot: string): string {
  const slot = accountSlot.replace(/^\/?u\/?/, '');
  return `https://docs.google.com/document/u/${slot}/d/${docId}/edit`;
}
