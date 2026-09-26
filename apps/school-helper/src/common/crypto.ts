/**
 * Local-only API key storage.
 *
 * Keys are encrypted with AES-GCM using a key derived from a device secret that
 * lives in chrome.storage.local (never synced, never exported by default).
 * This protects against a casual read of the IndexedDB file; it is not, and
 * cannot be, protection against malware already running as this user.
 * That limitation is stated in the README and KNOWN_ISSUES.
 */

const SECRET_KEY = 'school-helper.device-secret';
let cachedKey: CryptoKey | null = null;

async function deviceSecret(): Promise<string> {
  const area = globalThis.chrome?.storage?.local;
  if (area) {
    const got = await area.get(SECRET_KEY);
    if (typeof got[SECRET_KEY] === 'string') return got[SECRET_KEY];
    const fresh = randomHex(32);
    await area.set({ [SECRET_KEY]: fresh });
    return fresh;
  }
  // Test / non-extension context.
  const ls = globalThis.localStorage;
  if (ls) {
    const got = ls.getItem(SECRET_KEY);
    if (got) return got;
    const fresh = randomHex(32);
    ls.setItem(SECRET_KEY, fresh);
    return fresh;
  }
  return 'ephemeral-test-secret';
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const secret = await deviceSecret();
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  cachedKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode('school-helper.v1'),
      iterations: 120_000,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return cachedKey;
}

export async function encryptSecret(plaintext: string): Promise<string> {
  if (!plaintext) return '';
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1.${toB64(iv)}.${toB64(new Uint8Array(ct))}`;
}

export async function decryptSecret(cipher: string | undefined): Promise<string> {
  if (!cipher) return '';
  const [version, ivB64, ctB64] = cipher.split('.');
  if (version !== 'v1' || !ivB64 || !ctB64) return '';
  try {
    const key = await getKey();
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(ivB64) },
      key,
      fromB64(ctB64),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return '';
  }
}

/** Last 4 characters only — safe to render in the UI. */
export function maskKey(plaintext: string): string {
  if (!plaintext) return 'not set';
  if (plaintext.length <= 8) return '••••';
  return `${'•'.repeat(8)}${plaintext.slice(-4)}`;
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Scrub secrets out of a string before it can reach a log.
 *
 * `knownSecrets` is the authoritative path: the caller passes the actual key it
 * used, so a provider that echoes the key back in an error message cannot leak
 * it. The regexes are a backstop for keys we were not given.
 */
export function scrubSecrets(text: string, knownSecrets: (string | undefined)[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('REDACTED');
  }
  return out
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-REDACTED')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1REDACTED')
    .replace(/(x-api-key["':\s]+)[A-Za-z0-9._-]{8,}/gi, '$1REDACTED');
}
