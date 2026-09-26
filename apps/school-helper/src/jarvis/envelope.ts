/**
 * Ed25519 signed-request envelopes for the Jarvis cloud gateway.
 *
 * Ported from apps/d2l-extension/protocol.js. The private key is generated
 * non-extractable and never leaves the browser: `createKey` passes
 * `extractable: false`, so even our own code cannot export it. It is stored as
 * a live CryptoKey in IndexedDB (structured-clone), not as bytes.
 */

import { canonical } from './canonical';

export const AUDIENCE = 'jarvis-school-collector';
export const GATEWAY = 'https://jarvis-cloud-gateway.twilight-tree-70b1.workers.dev';

/** The only paths the transport may ever call. */
export const PATHS = Object.freeze([
  '/school/pairing/start',
  '/school/pairing/prove',
  '/school/pairing/status',
  '/school/observations',
] as const);

export type JarvisPath = (typeof PATHS)[number];

/** `/school/pairing/start` is the only unsigned call; it carries the new public key. */
export const SIGNED_PATHS = PATHS.slice(1) as readonly JarvisPath[];

export const REQUEST_TIMEOUT_MS = 15000;

const encoder = new TextEncoder();

function base64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export interface SignedEnvelope {
  schemaVersion: '1.0';
  deviceId: string;
  principalId: string;
  audience: string;
  issuedAt: number;
  nonce: string;
  bodyHash: string;
  signatureBase64: string;
}

export interface DeviceIdentity {
  collectorId: string;
  principalId: string;
}

export async function createKey(cryptoImpl: Crypto = crypto): Promise<CryptoKeyPair> {
  // extractable:false — the private half can never be read back out.
  return (await cryptoImpl.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

export async function publicKeyBase64(
  pair: CryptoKeyPair,
  cryptoImpl: Crypto = crypto,
): Promise<string> {
  return base64(await cryptoImpl.subtle.exportKey('raw', pair.publicKey));
}

/**
 * Signs the exact body bytes. Retries must reuse the same `body` string and
 * call this again for a fresh nonce — never re-serialize, or the hash moves.
 */
export async function sign(
  path: string,
  body: string,
  pair: CryptoKeyPair,
  identity: DeviceIdentity,
  issuedAt: number,
  cryptoImpl: Crypto = crypto,
): Promise<SignedEnvelope> {
  if (!(SIGNED_PATHS as readonly string[]).includes(path)) throw new Error('invalid-signed-path');
  const bytes = encoder.encode(body);
  const hash = await cryptoImpl.subtle.digest('SHA-256', bytes);
  const nonce = base64url(cryptoImpl.getRandomValues(new Uint8Array(32)));
  const bodyHash = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const envelope: Omit<SignedEnvelope, 'signatureBase64'> = {
    schemaVersion: '1.0',
    deviceId: identity.collectorId,
    principalId: identity.principalId,
    audience: AUDIENCE,
    issuedAt,
    nonce,
    bodyHash,
  };
  const message = encoder.encode(
    [
      'POST',
      path,
      envelope.deviceId,
      envelope.principalId,
      envelope.audience,
      envelope.issuedAt,
      envelope.nonce,
      envelope.bodyHash,
    ].join('\n'),
  );
  const signature = await cryptoImpl.subtle.sign('Ed25519', pair.privateKey, message);
  return { ...envelope, signatureBase64: base64(signature) };
}

/** Verifies a signature. Used by the fake gateway in tests, not in production. */
export async function verify(
  path: string,
  body: string,
  envelope: SignedEnvelope,
  publicKey: CryptoKey,
  cryptoImpl: Crypto = crypto,
): Promise<boolean> {
  const hash = await cryptoImpl.subtle.digest('SHA-256', encoder.encode(body));
  const bodyHash = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (bodyHash !== envelope.bodyHash) return false;
  const message = encoder.encode(
    [
      'POST',
      path,
      envelope.deviceId,
      envelope.principalId,
      envelope.audience,
      envelope.issuedAt,
      envelope.nonce,
      envelope.bodyHash,
    ].join('\n'),
  );
  const sig = Uint8Array.from(atob(envelope.signatureBase64), (c) => c.charCodeAt(0));
  const buf = new Uint8Array(new ArrayBuffer(sig.byteLength));
  buf.set(sig);
  return cryptoImpl.subtle.verify('Ed25519', publicKey, buf, message);
}

export { canonical };
