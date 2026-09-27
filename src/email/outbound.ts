/**
 * Outbound email: send from Sid's two real accounts (his decision, 2026-09-26).
 *
 *   personal → ksid1229@gmail.com   via the Gmail API (OAuth2 refresh token)
 *   school   → sk7qq09@limestone.on.ca via Microsoft Graph (OAuth2 refresh token)
 *
 * The MODEL chooses which account (the send_email tool's `from` argument is
 * required — code never defaults it). Code only maps account → provider and
 * refuses, loudly, when that account's secrets are not configured.
 *
 * HONESTY: a non-2xx from Google or Microsoft is returned as ok:false with
 * their own error text. "Sent" means the provider accepted the message —
 * delivery to the recipient's inbox is the provider's business, said so.
 * Tokens are never logged. FAIL CLOSED: with no refresh token / client
 * credentials for an account, that account returns not_connected.
 *
 * Trap #1: fetch is bound to globalThis ("Illegal invocation" in Workers).
 */

export type EmailAccount = "personal" | "school";

export interface EmailOutInput {
  to: string;
  subject: string;
  body: string;
}

export interface EmailOutResult {
  ok: boolean;
  status: string;
  detail?: string;
  /** The address the message was sent from, when it got that far. */
  fromAddress?: string;
}

export interface AccountConfig {
  provider: "gmail" | "graph";
  fromAddress: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  refreshToken: string | undefined;
  /** Graph only. */
  tenantId?: string | undefined;
}

export type EmailOutConfig = Partial<Record<EmailAccount, AccountConfig>>;

/** The slice of outbound email the tools need (so tests can fake it). */
export interface EmailOut {
  send(account: EmailAccount, input: EmailOutInput): Promise<EmailOutResult>;
  /** Which secrets are missing for an account, or null when it is configured. */
  missing(account: EmailAccount): string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class EmailSender implements EmailOut {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly cfg: EmailOutConfig,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  accountAddress(account: EmailAccount): string | undefined {
    return this.cfg[account]?.fromAddress;
  }

  missing(account: EmailAccount): string | null {
    const c = this.cfg[account];
    if (!c) return `no ${account} email account is configured`;
    const gaps: string[] = [];
    if (!c.clientId?.trim()) gaps.push("CLIENT_ID");
    if (!c.clientSecret?.trim()) gaps.push("CLIENT_SECRET");
    if (!c.refreshToken?.trim()) gaps.push("REFRESH_TOKEN");
    if (c.provider === "graph" && !c.tenantId?.trim()) gaps.push("TENANT_ID");
    return gaps.length > 0 ? gaps.join(", ") : null;
  }

  async send(account: EmailAccount, input: EmailOutInput): Promise<EmailOutResult> {
    const c = this.cfg[account];
    const gap = this.missing(account);
    if (!c || gap) {
      return {
        ok: false,
        status: "not_connected",
        detail: `The ${account} email account is not configured (${gap ?? "missing"}). Nothing was sent.`,
      };
    }
    if (!EMAIL_RE.test(input.to)) {
      return { ok: false, status: "refused", detail: `not a valid email address: ${input.to}` };
    }
    if (input.subject.trim() === "" || input.body.trim() === "") {
      return { ok: false, status: "refused", detail: "subject and body must not be empty" };
    }
    try {
      return c.provider === "gmail" ? await this.sendGmail(c, input) : await this.sendGraph(c, input);
    } catch (e) {
      return { ok: false, status: "network_error", detail: (e as Error).message };
    }
  }

  /** Exchange the refresh token for a short-lived access token. */
  private async accessToken(c: AccountConfig): Promise<{ ok: true; token: string } | { ok: false; status: string; detail: string }> {
    if (c.provider === "gmail") {
      const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: c.clientId!,
          client_secret: c.clientSecret!,
          refresh_token: c.refreshToken!,
          grant_type: "refresh_token",
        }).toString(),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) return { ok: false, status: `gmail_auth_${res.status}`, detail: redact(text).slice(0, 300) };
      try {
        return { ok: true, token: (JSON.parse(text) as { access_token: string }).access_token };
      } catch {
        return { ok: false, status: "gmail_auth_bad_response", detail: "token endpoint returned unparseable JSON" };
      }
    }
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(c.tenantId!)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.clientId!,
        client_secret: c.clientSecret!,
        refresh_token: c.refreshToken!,
        grant_type: "refresh_token",
        scope: "https://graph.microsoft.com/.default",
      }).toString(),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, status: `graph_auth_${res.status}`, detail: redact(text).slice(0, 300) };
    try {
      return { ok: true, token: (JSON.parse(text) as { access_token: string }).access_token };
    } catch {
      return { ok: false, status: "graph_auth_bad_response", detail: "token endpoint returned unparseable JSON" };
    }
  }

  private async sendGmail(c: AccountConfig, input: EmailOutInput): Promise<EmailOutResult> {
    const auth = await this.accessToken(c);
    if (!auth.ok) return { ok: false, status: auth.status, detail: auth.detail };
    // Gmail wants the full RFC 5322 message, base64url-encoded.
    const mime = [
      `From: ${c.fromAddress}`,
      `To: ${input.to}`,
      `Subject: ${encodeHeader(input.subject)}`,
      'Content-Type: text/plain; charset="utf-8"',
      "MIME-Version: 1.0",
      "",
      input.body,
    ].join("\r\n");
    const raw = base64Url(new TextEncoder().encode(mime));
    const res = await this.fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, status: `gmail_${res.status}`, detail: redact(text).slice(0, 300), fromAddress: c.fromAddress };
    return { ok: true, status: "sent", fromAddress: c.fromAddress };
  }

  private async sendGraph(c: AccountConfig, input: EmailOutInput): Promise<EmailOutResult> {
    const auth = await this.accessToken(c);
    if (!auth.ok) return { ok: false, status: auth.status, detail: auth.detail };
    const res = await this.fetchImpl(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(c.fromAddress)}/sendMail`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: input.subject,
            body: { contentType: "Text", content: input.body },
            toRecipients: [{ emailAddress: { address: input.to } }],
          },
          saveToSentItems: true,
        }),
      },
    );
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, status: `graph_${res.status}`, detail: redact(text).slice(0, 300), fromAddress: c.fromAddress };
    return { ok: true, status: "sent", fromAddress: c.fromAddress };
  }
}

/** Non-ASCII headers get RFC 2047 B-words; ASCII passes through. */
function encodeHeader(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** OAuth error bodies can echo tokens; strip anything token-shaped before it becomes a log line. */
function redact(text: string): string {
  return text.replace(/ya29\.[A-Za-z0-9_-]+/g, "ya29.[REDACTED]").replace(/1[A-Za-z0-9._-]{20,}@example\.com/g, "[REDACTED]");
}
