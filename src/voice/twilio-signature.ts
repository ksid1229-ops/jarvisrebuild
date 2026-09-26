/**
 * Twilio request signature verification for the voice webhook. Twilio signs
 * every request; we verify it so a spoofed webhook cannot start a call session.
 *
 * The signature is base64(HMAC-SHA1(authToken, fullUrl + concat(sorted param
 * key+value))). FAIL CLOSED: with no auth token configured, verification returns
 * false and the webhook is refused.
 */
export async function verifyTwilioSignature(
  authToken: string | undefined,
  fullUrl: string,
  params: Record<string, string>,
  providedSignature: string | null,
): Promise<boolean> {
  if (!authToken || authToken.trim() === "") return false; // fail closed
  if (!providedSignature) return false;

  let data = fullUrl;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }

  const keyData = new TextEncoder().encode(authToken);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  const expected = base64(new Uint8Array(sig));
  return timingSafeEqual(expected, providedSignature);
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa exists in Workers and Node 18+ globals.
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
