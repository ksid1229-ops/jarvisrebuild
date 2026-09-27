/**
 * Worker environment bindings.
 *
 * Config that, when missing, must make Jarvis FAIL CLOSED rather than guess:
 *  - OWNER_CHAT_ID:  without it, nobody is the owner. We never treat everyone as Sid.
 *  - TELEGRAM_WEBHOOK_SECRET: without it, every webhook is refused.
 *  - OWNER_ACTION_PIN: without it, ordinary calls still work but every one of the
 *    five confirmed actions on a call refuses. That is the safe direction.
 *  - DEEPSEEK_API_KEY: without it, there is no model. We say so plainly; we never
 *    fall back to a keyword bot pretending to be the model.
 */
export interface Env {
  // --- Cloudflare resource bindings (production) ---
  DB?: unknown; // D1Database
  ARCHIVE?: unknown; // R2Bucket
  BACKUP?: unknown; // R2Bucket
  MEMORY_VECTORS?: unknown; // Vectorize
  AI?: unknown; // Workers AI
  JARVIS?: unknown; // DurableObjectNamespace

  // --- Owner identity / secrets ---
  OWNER_CHAT_ID?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  OWNER_ACTION_PIN?: string;
  OWNER_PIN_PEPPER?: string;

  // --- Twilio (voice) ---
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_E164?: string;
  PUBLIC_ORIGIN?: string;
  /** Sid's own phone number (E.164), for caller-id on inbound calls. Missing => nobody is owner. */
  OWNER_PHONE_E164?: string;

  // --- Model ---
  DEEPSEEK_API_KEY?: string;
  /** Main model. Sid chose DeepSeek V4.1 Flash for every path; do not switch on your own. */
  DEEPSEEK_MODEL?: string;
  /**
   * Memory-extraction model. Defaults to the main model (brief section 5). Kept a
   * separate config value so extraction can point at a stronger model with no code
   * change if real extractions ever prove poor.
   */
  MEMORY_EXTRACTION_MODEL?: string;

  // --- Timezone ---
  /** Sid's IANA timezone. Ontario => America/Toronto (handles EST/EDT + DST). */
  OWNER_TIMEZONE?: string;

  // --- Queues (slow work: email processing) ---
  /** Cloudflare Queues producer binding (queue "jarvis-work"). */
  WORK_QUEUE?: unknown;

  // --- Sid's Windows PC agent ---
  /** Shared secret the PC agent presents as a bearer token. Missing => every /pc request is refused. */
  PC_AGENT_TOKEN?: string;

  // --- Outbound email (Sid's two real accounts, 2026-09-26) ---
  /** personal = ksid1229@gmail.com via the Gmail API. */
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  /** school = sk7qq09@limestone.on.ca via Microsoft Graph. */
  MS_GRAPH_CLIENT_ID?: string;
  MS_GRAPH_CLIENT_SECRET?: string;
  MS_GRAPH_REFRESH_TOKEN?: string;
  MS_GRAPH_TENANT_ID?: string;
  /** From-address overrides; the addresses above are the defaults. */
  OWNER_EMAIL_PERSONAL?: string;
  OWNER_EMAIL_SCHOOL?: string;

  // --- Watchdog ---
  /** Healthchecks.io ping URL. Missing => the watchdog reports not_connected. */
  WATCHDOG_PING_URL?: string;

  // --- Vault sync ---
  VAULT_EXPORT_TOKEN?: string;
}
