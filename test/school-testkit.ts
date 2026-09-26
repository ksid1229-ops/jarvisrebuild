/**
 * Shared signing helpers for school tests. Mirrors the School Helper app's
 * sign() with the FIXED contract: issuedAt is an ISO-8601 UTC string.
 */
import { encodeBase64Url, type SignedRequestV1 } from "../src/school/signed-request.js";

export function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function genKeypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
}

export async function publicKeyB64(pair: CryptoKeyPair): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return b64(new Uint8Array(raw));
}

export async function signEnvelope(opts: {
  path: string;
  body: string;
  keys: CryptoKeyPair;
  deviceId: string;
  principalId: string;
  issuedAt: string;
  nonce?: string;
}): Promise<SignedRequestV1> {
  const bodyBytes = new TextEncoder().encode(opts.body);
  const hash = await crypto.subtle.digest("SHA-256", bodyBytes);
  const bodyHash = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const nonce = opts.nonce ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const unsigned = {
    schemaVersion: "1.0" as const,
    deviceId: opts.deviceId,
    principalId: opts.principalId,
    audience: "jarvis-school-collector",
    issuedAt: opts.issuedAt,
    nonce,
    bodyHash,
  };
  const message = new TextEncoder().encode(
    ["POST", opts.path, unsigned.deviceId, unsigned.principalId, unsigned.audience,
      unsigned.issuedAt, unsigned.nonce, unsigned.bodyHash].join("\n"),
  );
  const signature = await crypto.subtle.sign("Ed25519", opts.keys.privateKey, message);
  return { ...unsigned, signatureBase64: b64(new Uint8Array(signature)) };
}
