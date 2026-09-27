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

/**
 * The URLs Twilio may have signed for a request that reached us at
 * `requestUrl`. Twilio signs the exact public URL it dialed. Behind Cloudflare,
 * `request.url` can differ from that (custom domain vs workers.dev, scheme), so
 * PUBLIC_ORIGIN — the same origin we hand Twilio in TwiML — is tried first.
 * For the ConversationRelay WebSocket handshake Twilio dialed a wss:// URL, so
 * both the wss:// and https:// spellings are candidates. Every candidate still
 * needs a valid HMAC from the auth token, so trying several weakens nothing.
 */
export function twilioSignedUrlCandidates(requestUrl: string, publicOrigin: string | undefined, websocket = false): string[] {
  const req = new URL(requestUrl);
  const pathAndQuery = req.pathname + req.search;
  const bases: string[] = [];
  if (publicOrigin && publicOrigin.trim() !== "") bases.push(publicOrigin.trim().replace(/\/+$/, ""));
  bases.push(req.origin);
  const out: string[] = [];
  for (const base of bases) {
    const https = base.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    const wss = https.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    if (websocket) out.push(wss + pathAndQuery);
    out.push(https + pathAndQuery);
  }
  return [...new Set(out)];
}

/** True when the signature matches ANY candidate URL (see twilioSignedUrlCandidates). */
export async function verifyTwilioSignatureAny(
  authToken: string | undefined,
  candidateUrls: string[],
  params: Record<string, string>,
  providedSignature: string | null,
): Promise<boolean> {
  for (const url of candidateUrls) {
    if (await verifyTwilioSignature(authToken, url, params, providedSignature)) return true;
  }
  return false;
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
