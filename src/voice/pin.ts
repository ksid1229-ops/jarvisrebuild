/**
 * Owner PIN for the five confirmed actions on a call (brief section 3). The PIN
 * is stored/compared as a HASH, never in the clear. Keypad (DTMF) and spoken
 * digits both arrive here as a 4-digit string.
 *
 * FAIL CLOSED: if the configured PIN is missing or malformed, the verifier
 * always returns false — an ordinary call still works, but every one of the five
 * actions on a call refuses. That is the direction that cannot run unguarded.
 */

async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const FOUR_DIGITS = /^\d{4}$/;

export type OwnerPinVerifier = (entered: string) => Promise<boolean>;

/** Build a verifier that compares hashes. Missing/malformed config => always false. */
export function makeOwnerPinVerifier(configuredPin?: string, pepper?: string): OwnerPinVerifier {
  return async (entered: string): Promise<boolean> => {
    if (!configuredPin || !FOUR_DIGITS.test(configuredPin)) return false; // fail closed
    if (!FOUR_DIGITS.test(entered)) return false;
    const salt = pepper ?? "";
    const want = await sha256hex(`${salt}:${configuredPin}`);
    const got = await sha256hex(`${salt}:${entered}`);
    return timingSafeEqualHex(want, got);
  };
}

/** Hash a guest PIN for storage. */
export async function hashPin(pin: string, pepper = ""): Promise<string> {
  return sha256hex(`${pepper}:${pin}`);
}

export async function verifyHashedPin(entered: string, hash: string, pepper = ""): Promise<boolean> {
  if (!FOUR_DIGITS.test(entered)) return false;
  const got = await sha256hex(`${pepper}:${entered}`);
  return timingSafeEqualHex(got, hash);
}
