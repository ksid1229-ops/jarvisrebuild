/**
 * Twilio REST client: SMS out and calls out. One small adapter shared by the
 * SMS owner channel, contact_on_behalf and call_place.
 *
 * HONESTY: a non-2xx from Twilio or a network error is returned as ok:false with
 * Twilio's own error text — never reported as sent. FAIL CLOSED: with no account
 * SID, auth token or from-number, every call returns not_connected.
 *
 * Trap #1: fetch is bound to globalThis ("Illegal invocation" in Workers).
 */

export interface TwilioConfig {
  accountSid: string | undefined;
  authToken: string | undefined;
  /** The Twilio number Jarvis texts and calls from (E.164). */
  fromE164: string | undefined;
}

export interface TwilioSendResult {
  ok: boolean;
  status: string;
  detail?: string;
  /** Twilio resource SIDs (one per SMS part, or the call SID). */
  sids?: string[];
}

/** Twilio's per-message body limit (it concatenates segments up to this). */
export const SMS_MAX_BODY = 1600;

/** How long a single Twilio API call may hang before the turn gives up on it. */
export const TWILIO_TIMEOUT_MS = 10_000;

const E164 = /^\+[1-9]\d{6,14}$/;

export function isE164(v: string): boolean {
  return E164.test(v);
}

export class TwilioRestClient {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly cfg: TwilioConfig,
    fetchImpl?: typeof fetch,
    private readonly timeoutMs = TWILIO_TIMEOUT_MS,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Which config is missing, or null when everything needed is set. */
  missing(): string | null {
    const gaps: string[] = [];
    if (!this.cfg.accountSid?.trim()) gaps.push("TWILIO_ACCOUNT_SID");
    if (!this.cfg.authToken?.trim()) gaps.push("TWILIO_AUTH_TOKEN");
    if (!this.cfg.fromE164?.trim()) gaps.push("TWILIO_FROM_E164");
    return gaps.length > 0 ? gaps.join(", ") : null;
  }

  /**
   * Send an SMS. A body over 1600 characters is sent as several messages in
   * order; if one fails, sending stops and the result says how many arrived.
   */
  async sendSms(to: string, body: string): Promise<TwilioSendResult> {
    const gap = this.missing();
    if (gap) return { ok: false, status: "not_connected", detail: `Twilio is not configured (${gap} unset).` };
    if (!isE164(to)) return { ok: false, status: "refused", detail: `not an E.164 phone number: ${to}` };
    const parts = splitSms(body);
    const sids: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const res = await this.post("Messages.json", { To: to, From: this.cfg.fromE164!, Body: parts[i]! });
      if (!res.ok) {
        const where = parts.length > 1 ? ` (part ${i + 1} of ${parts.length}; ${i} delivered to Twilio before it)` : "";
        return { ...res, detail: `${res.detail ?? ""}${where}`.trim(), sids };
      }
      if (res.sid) sids.push(res.sid);
    }
    return { ok: true, status: "ok", sids, ...(parts.length > 1 ? { detail: `sent as ${parts.length} messages` } : {}) };
  }

  /**
   * Start an outbound call. Either `url` (Twilio fetches TwiML from it, with
   * machine detection results when enabled) or inline `twiml`.
   */
  async createCall(input: {
    to: string;
    url?: string;
    twiml?: string;
    /** Enable: answer vs machine reported to `url`. DetectMessageEnd: TwiML waits for the voicemail beep. */
    machineDetection?: "Enable" | "DetectMessageEnd";
    statusCallback?: string;
  }): Promise<TwilioSendResult> {
    const gap = this.missing();
    if (gap) return { ok: false, status: "not_connected", detail: `Twilio is not configured (${gap} unset).` };
    if (!isE164(input.to)) return { ok: false, status: "refused", detail: `not an E.164 phone number: ${input.to}` };
    const form: Record<string, string> = { To: input.to, From: this.cfg.fromE164! };
    if (input.url) form.Url = input.url;
    if (input.twiml) form.Twiml = input.twiml;
    if (input.machineDetection) form.MachineDetection = input.machineDetection;
    if (input.statusCallback) {
      form.StatusCallback = input.statusCallback;
      form.StatusCallbackMethod = "POST";
      // Final outcomes only; "completed" also arrives for answered calls.
      form.StatusCallbackEvent = "completed";
    }
    const res = await this.post("Calls.json", form);
    return res.ok ? { ok: true, status: "ok", sids: res.sid ? [res.sid] : [] } : res;
  }

  private async post(resource: string, form: Record<string, string>): Promise<TwilioSendResult & { sid?: string }> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid!)}/${resource}`;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${this.cfg.accountSid}:${this.cfg.authToken}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form).toString(),
        // Audit round 3: SMS replies sit on every turn's reply path.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) return { ok: false, status: `twilio_${res.status}`, detail: text.slice(0, 300) };
      let sid: string | undefined;
      try {
        sid = (JSON.parse(text) as { sid?: string }).sid;
      } catch {
        sid = undefined;
      }
      return { ok: true, status: "ok", ...(sid ? { sid } : {}) };
    } catch (e) {
      if ((e as Error).name === "TimeoutError") {
        return { ok: false, status: "timeout", detail: `Twilio did not answer within ${this.timeoutMs}ms` };
      }
      return { ok: false, status: "network_error", detail: (e as Error).message };
    }
  }
}

/** Split an SMS body into ≤1600-character parts at a line break or space where possible. */
export function splitSms(text: string, max = SMS_MAX_BODY): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut < max / 2) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    } else {
      cut += 1;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/** Minimal XML escaping for TwiML text and attributes. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
