import type { Env } from "./env.js";
import { SystemClock } from "./clock.js";
import { verifyTelegramWebhook } from "./router/telegram-webhook.js";
import { buildJarvis } from "./jarvis/build.js";
import { DeepSeekModel } from "./model/deepseek.js";
import { MissingModelKeyError } from "./model/types.js";
import { TelegramChannel } from "./channels/telegram-channel.js";
import { FakeEmbeddingProvider, InMemoryVectorIndex, WorkersAiEmbeddingProvider } from "./memory/embeddings.js";
import { newId } from "./ids.js";
import type { JarvisEvent } from "./jarvis/agent-core.js";
import { AppEventsRepo, wakeOnAppEvent } from "./apps/app-events.js";
import { buildConnectTwiml } from "./voice/twiml.js";
import { verifyTwilioSignature } from "./voice/twilio-signature.js";
import { handleCron } from "./scheduler/cron.js";
import { buildVaultExport, authorizeVaultExport } from "./plumbing/vault.js";

/**
 * Worker router. Receives Telegram webhooks, verifies them (fail closed), and
 * hands the owner's update to the Jarvis Durable Object.
 *
 * HONESTY / KNOWN LIMIT: this build's repositories are in-memory (fully tested).
 * A D1/DO-storage-backed persistence adapter is the documented next step
 * (see rebuild/PROGRESS.md). The DO keeps state for its lifetime; it is not yet
 * persisted across evictions. Nothing here fakes success.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, at: new SystemClock().nowIso() });
    }

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, reason: "bad json" }, 400);
      }
      const decision = verifyTelegramWebhook(secret, body, env);
      if (!decision.ok || !decision.update) {
        return json({ ok: decision.ok, reason: decision.reason }, decision.status);
      }

      // Route to the owner's Durable Object.
      const ns = env.JARVIS as DurableObjectNamespace | undefined;
      if (!ns) {
        return json({ ok: false, reason: "JARVIS DO binding missing" }, 500);
      }
      const id = ns.idFromName(decision.update.chatId);
      const stub = ns.get(id);
      const resp = await stub.fetch("https://do/telegram", {
        method: "POST",
        body: JSON.stringify(decision.update),
        headers: { "content-type": "application/json" },
      });
      return resp;
    }

    // Apps give Jarvis senses: an authenticated event endpoint. The app posts
    // { appName, authSecret, payload }; the DO verifies the secret against the
    // registry, stores the event and wakes Jarvis. Auth is checked in the DO
    // (that is where the registry lives).
    if (url.pathname === "/apps/event" && request.method === "POST") {
      const ns = env.JARVIS as DurableObjectNamespace | undefined;
      if (!ns) return json({ ok: false, reason: "JARVIS DO binding missing" }, 500);
      if (!env.OWNER_CHAT_ID) return json({ ok: false, reason: "OWNER_CHAT_ID not configured" }, 500);
      const bodyText = await request.text();
      const id = ns.idFromName(env.OWNER_CHAT_ID);
      const stub = ns.get(id);
      return stub.fetch("https://do/apps/event", {
        method: "POST",
        body: bodyText,
        headers: { "content-type": "application/json" },
      });
    }

    // Twilio inbound voice webhook. Verify the Twilio signature (fail closed),
    // then return TwiML that connects the call to ConversationRelay pointed at a
    // WebSocket on the Jarvis DO. The caller is identified (owner/guest/unknown)
    // when the WebSocket connects; the five actions still require the PIN there.
    if (url.pathname === "/voice" && request.method === "POST") {
      const form = await request.formData().catch(() => null);
      if (!form) return json({ ok: false, reason: "expected form-encoded body" }, 400);
      const params: Record<string, string> = {};
      form.forEach((v, k) => {
        params[k] = String(v);
      });
      const sig = request.headers.get("x-twilio-signature");
      const ok = await verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, request.url, params, sig);
      if (!ok) return json({ ok: false, reason: "bad twilio signature" }, 403);

      const origin = env.PUBLIC_ORIGIN ?? url.origin;
      const wsOrigin = origin.replace(/^http/, "ws");
      const from = params.From ?? "";
      const wsUrl = `${wsOrigin}/voice/ws?from=${encodeURIComponent(from)}&callSid=${encodeURIComponent(params.CallSid ?? "")}`;
      return new Response(buildConnectTwiml(wsUrl), {
        status: 200,
        headers: { "content-type": "text/xml" },
      });
    }

    // Vault export (Phase 7): one-way pull for the Windows PC script. Token-gated
    // (fail closed). Routes to the DO where the data lives.
    if (url.pathname === "/vault/export") {
      const ns = env.JARVIS as DurableObjectNamespace | undefined;
      if (!ns) return json({ ok: false, reason: "JARVIS DO binding missing" }, 500);
      if (!env.OWNER_CHAT_ID) return json({ ok: false, reason: "OWNER_CHAT_ID not configured" }, 500);
      const stub = ns.get(ns.idFromName(env.OWNER_CHAT_ID));
      const token = request.headers.get("x-vault-token") ?? url.searchParams.get("token");
      return stub.fetch(`https://do/vault/export`, { headers: { "x-vault-token": token ?? "" } });
    }

    return json({ ok: false, reason: "not found" }, 404);
  },

  /** Cron entry point. Cloudflare passes the matched cron string in event.cron. */
  async scheduled(event: { cron: string }, env: Env): Promise<void> {
    const ns = env.JARVIS as DurableObjectNamespace | undefined;
    if (!ns || !env.OWNER_CHAT_ID) return;
    const stub = ns.get(ns.idFromName(env.OWNER_CHAT_ID));
    await stub.fetch(`https://do/cron?expr=${encodeURIComponent(event.cron)}`, { method: "POST" });
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/**
 * The Jarvis Durable Object — one per owner. Holds conversation state and runs
 * the model loop. Text, calls, emails and wake-ups all reach this same brain.
 */
export class JarvisDurableObject {
  private built: ReturnType<typeof buildJarvis> | null = null;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  private ensureBuilt(chatId: string): ReturnType<typeof buildJarvis> {
    if (this.built) return this.built;
    const clock = new SystemClock();

    // The model. No key => no model. We do NOT fall back to a keyword bot.
    let model;
    try {
      model = new DeepSeekModel({
        apiKey: this.env.DEEPSEEK_API_KEY ?? "",
        model: this.env.DEEPSEEK_MODEL,
      });
    } catch (e) {
      if (e instanceof MissingModelKeyError) throw e;
      throw e;
    }

    const ai = this.env.AI as { run(model: string, input: unknown): Promise<any> } | undefined;
    const embeddings = ai ? new WorkersAiEmbeddingProvider(ai) : new FakeEmbeddingProvider();
    const vectors = new InMemoryVectorIndex(); // Vectorize adapter is the production swap-in.

    const ownerChannel = new TelegramChannel(this.env.TELEGRAM_BOT_TOKEN ?? "", chatId);

    this.built = buildJarvis({
      model,
      clock,
      embeddings,
      vectors,
      ownerChannel,
      ownerId: chatId,
      timezone: this.env.OWNER_TIMEZONE ?? "America/Toronto",
      ...(this.env.OWNER_ACTION_PIN ? { ownerPin: this.env.OWNER_ACTION_PIN } : {}),
      ...(this.env.OWNER_PIN_PEPPER ? { pinPepper: this.env.OWNER_PIN_PEPPER } : {}),
    });
    return this.built;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/apps/event") {
      return this.handleAppEvent(request);
    }
    if (url.pathname === "/cron") {
      return this.handleCronRequest(url);
    }
    if (url.pathname === "/vault/export") {
      return this.handleVaultExport(request);
    }
    const update = (await request.json()) as {
      chatId: string;
      text: string;
      provenance: JarvisEvent["provenance"];
      callbackData?: string;
    };

    let built;
    try {
      built = this.ensureBuilt(update.chatId);
    } catch (e) {
      if (e instanceof MissingModelKeyError) {
        // Say so plainly. Tell Sid over Telegram; do not pretend to answer.
        const ch = new TelegramChannel(this.env.TELEGRAM_BOT_TOKEN ?? "", update.chatId);
        await ch.sendText("I have no model configured (DEEPSEEK_API_KEY is unset), so I can't answer. Nothing was faked.");
        return json({ ok: false, reason: "no model key" }, 200);
      }
      throw e;
    }

    const event: JarvisEvent = {
      channel: "text",
      trigger: "text",
      provenance: update.provenance,
      text: update.text,
      eventId: newId("evt"),
    };

    const result = await built.agent.handle(event);

    // Deliver the reply. A failed send is surfaced in the response, not hidden.
    if (result.error) {
      const ch = new TelegramChannel(this.env.TELEGRAM_BOT_TOKEN ?? "", update.chatId);
      await ch.sendText(`Something went wrong reaching the model: ${result.error}`);
      return json({ ok: false, reason: result.error }, 200);
    }
    if (result.reply.trim() !== "") {
      const ch = new TelegramChannel(this.env.TELEGRAM_BOT_TOKEN ?? "", update.chatId);
      const send = await ch.sendText(result.reply);
      return json({ ok: send.ok, sendStatus: send.status });
    }
    return json({ ok: true, note: "no reply text (model may have acted via tools or stayed quiet)" });
  }

  private async handleAppEvent(request: Request): Promise<Response> {
    const ownerId = this.env.OWNER_CHAT_ID ?? "";
    const body = (await request.json()) as { appName?: string; authSecret?: string; payload?: unknown };
    let built;
    try {
      built = this.ensureBuilt(ownerId);
    } catch (e) {
      if (e instanceof MissingModelKeyError) return json({ ok: false, reason: "no model key" }, 200);
      throw e;
    }
    const app = built.appsRepo.byName(String(body.appName ?? ""));
    // Verify the app is registered and the secret matches. Fail closed.
    if (!app || !body.authSecret || body.authSecret !== app.authSecret) {
      return json({ ok: false, reason: "unknown app or bad secret" }, 401);
    }
    const events = new AppEventsRepo(new SystemClock());
    const ev = events.store(app.name, body.payload);
    const result = await wakeOnAppEvent(built.agent, ev, ownerId);
    return json({ ok: !result.error, note: "event delivered to Jarvis" });
  }

  private async handleCronRequest(url: URL): Promise<Response> {
    const ownerId = this.env.OWNER_CHAT_ID ?? "";
    let built;
    try {
      built = this.ensureBuilt(ownerId);
    } catch (e) {
      if (e instanceof MissingModelKeyError) return json({ ok: false, reason: "no model key" }, 200);
      throw e;
    }
    const expr = url.searchParams.get("expr") ?? "";
    const result = await handleCron({
      cronExpr: expr,
      agent: built.agent,
      scheduler: built.wakeups,
      heartbeat: built.heartbeat,
      watchdog: built.watchdog,
      backup: built.backup,
    });
    return json({ ok: true, result });
  }

  private async handleVaultExport(request: Request): Promise<Response> {
    const ownerId = this.env.OWNER_CHAT_ID ?? "";
    let built;
    try {
      built = this.ensureBuilt(ownerId);
    } catch (e) {
      if (e instanceof MissingModelKeyError) return json({ ok: false, reason: "no model key" }, 200);
      throw e;
    }
    const token = request.headers.get("x-vault-token");
    if (!authorizeVaultExport(token, this.env.VAULT_EXPORT_TOKEN)) {
      return json({ ok: false, reason: "vault export requires a valid token" }, 401);
    }
    const exported = buildVaultExport(built.facts.all(), built.wakeupsRepo.list());
    return json({ ok: true, count: exported.count, notes: exported.notes });
  }
}
