import type { Env } from "./env.js";
import { SystemClock } from "./clock.js";
import { eventTextFor, verifyTelegramWebhook } from "./router/telegram-webhook.js";
import { buildJarvis } from "./jarvis/build.js";
import { DeepSeekModel } from "./model/deepseek.js";
import { MissingModelKeyError } from "./model/types.js";
import { TelegramChannel } from "./channels/telegram-channel.js";
import {
  CloudflareVectorizeIndex,
  InMemoryVectorIndex,
  UnavailableEmbeddingProvider,
  WorkersAiEmbeddingProvider,
  type VectorizeLike,
} from "./memory/embeddings.js";
import { D1MemoryRunsRepo } from "./memory/memory-review.js";
import { R2BucketAdapter, type R2Like } from "./plumbing/bucket.js";
import { newId } from "./ids.js";
import type { JarvisEvent } from "./jarvis/agent-core.js";
import { AppEventsRepo, D1AppEventsRepo, wakeOnAppEvent } from "./apps/app-events.js";
import { buildConnectTwiml } from "./voice/twiml.js";
import { twilioSignedUrlCandidates, verifyTwilioSignatureAny } from "./voice/twilio-signature.js";
import { VoiceRelay } from "./voice/relay.js";
import { fireWakeup, handleCron } from "./scheduler/cron.js";
import { buildVaultExport, authorizeVaultExport } from "./plumbing/vault.js";
import type { D1Db } from "./persistence/d1.js";
import { D1FactsRepo } from "./memory/facts-repo.js";
import { D1ConversationRepo } from "./conversation/conversation-repo.js";
import { D1ReceiptsRepo } from "./receipts/receipts-repo.js";
import { D1PendingActionsRepo } from "./confirmations/pending-actions.js";
import { D1SettingsRepo } from "./settings/settings-repo.js";
import { D1ConnectedAppsRepo } from "./apps/app-registry.js";
import { D1GuestsRepo } from "./voice/guests-repo.js";
import { D1WakeupsRepo } from "./scheduler/wakeups-repo.js";
import { D1HeartbeatRepo } from "./plumbing/heartbeat.js";
import { COLLECTOR_ENVELOPE_HEADER, handleSchoolRequest } from "./school/routes.js";
import { schoolVaultSnapshot } from "./school/school-tools.js";
import { acceptSmsWebhook, EMPTY_TWIML, smsEventText, type AcceptedSms } from "./router/sms-webhook.js";
import { TwilioRestClient } from "./channels/twilio-rest.js";
import { OwnerTextChannels, type MediumSender } from "./channels/owner-text-channels.js";
import { describeCallOutcome, recallOutbound, type OutboundCallRecord } from "./channels/phone.js";
import type { TextMedium } from "./types.js";
import { acceptInboundEmail, wakeTextFor } from "./email/email-worker.js";
import { D1EmailsRepo } from "./email/email-repo.js";
import { EmailSender } from "./email/outbound.js";
import { D1PcJobsRepo } from "./pc/pc-jobs-repo.js";
import { D1PcHeartbeatRepo } from "./pc/pc-tools.js";
import { safeEqual } from "./router/telegram-webhook.js";

/** The slice of a Cloudflare Queues producer the email path needs. */
interface QueueProducerLike {
  send(message: unknown): Promise<void>;
}

/** The slice of a Cloudflare Email Worker message (ForwardableEmailMessage). */
interface InboundEmailMessage {
  raw: ReadableStream;
  from: string;
  to: string;
  setReject(reason: string): void;
}

/** Settings key: the text medium Sid last messaged from (a recorded fact). */
const LAST_TEXT_MEDIUM = "last_text_medium";

/**
 * Worker router. Receives Telegram webhooks, verifies them (fail closed), and
 * hands the owner's update to the Jarvis Durable Object.
 *
 * Storage: when the DB binding is present the DO runs on D1-backed stores
 * (same interfaces, same semantics, real persistence across evictions). Without
 * it — local dev with no D1 — it falls back to in-memory stores, which lose
 * state on eviction. Nothing here fakes success either way.
 */
export default {
  async fetch(request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
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

    // Twilio inbound SMS/MMS — Sid's second text channel. Verified (fail closed)
    // and owner-checked here; Twilio gets an empty TwiML answer immediately (its
    // webhook times out at 15 s, a model turn can take longer) and the turn runs
    // in the background, replying over the REST API on SMS.
    if (url.pathname === "/sms" && request.method === "POST") {
      const form = await request.formData().catch(() => null);
      if (!form) return json({ ok: false, reason: "expected form-encoded body" }, 400);
      const params: Record<string, string> = {};
      form.forEach((v, k) => {
        params[k] = String(v);
      });
      const decision = await acceptSmsWebhook(params, request.headers.get("x-twilio-signature"), request.url, env);
      if (!decision.sms) {
        if (decision.status === 200) {
          return new Response(EMPTY_TWIML, { status: 200, headers: { "content-type": "text/xml" } });
        }
        return json({ ok: false, reason: decision.reason }, decision.status);
      }
      const ns = env.JARVIS as DurableObjectNamespace | undefined;
      if (!ns) return json({ ok: false, reason: "JARVIS DO binding missing" }, 500);
      if (!env.OWNER_CHAT_ID) return json({ ok: false, reason: "OWNER_CHAT_ID not configured" }, 500);
      if (!ctx) return json({ ok: false, reason: "no execution context to run the turn in" }, 500);
      const stub = ns.get(ns.idFromName(env.OWNER_CHAT_ID));
      ctx.waitUntil(
        stub
          .fetch("https://do/sms", {
            method: "POST",
            body: JSON.stringify(decision.sms),
            headers: { "content-type": "application/json" },
          })
          .catch((e: unknown) => console.error("sms turn failed:", (e as Error).message)),
      );
      return new Response(EMPTY_TWIML, { status: 200, headers: { "content-type": "text/xml" } });
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
      // Twilio signs the public URL it dialed; PUBLIC_ORIGIN is that origin.
      const ok = await verifyTwilioSignatureAny(
        env.TWILIO_AUTH_TOKEN,
        twilioSignedUrlCandidates(request.url, env.PUBLIC_ORIGIN),
        params,
        sig,
      );
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

    // Jarvis's own outbound call to Sid (call_place) was answered. Twilio fetches
    // this with machine detection results. A person → the same ConversationRelay
    // as inbound calls, marked outbound. Voicemail/fax → hang up without leaving
    // a message (anyone might hear it); the status callback tells Jarvis.
    if (url.pathname === "/voice/outbound" && request.method === "POST") {
      const params = await formParams(request);
      if (!params) return json({ ok: false, reason: "expected form-encoded body" }, 400);
      const ok = await verifyTwilioSignatureAny(
        env.TWILIO_AUTH_TOKEN,
        twilioSignedUrlCandidates(request.url, env.PUBLIC_ORIGIN),
        params,
        request.headers.get("x-twilio-signature"),
      );
      if (!ok) return json({ ok: false, reason: "bad twilio signature" }, 403);
      const answeredBy = params.AnsweredBy ?? "";
      if (/^(machine|fax)/.test(answeredBy)) {
        return new Response('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>', {
          status: 200,
          headers: { "content-type": "text/xml" },
        });
      }
      const wsOrigin = (env.PUBLIC_ORIGIN ?? url.origin).replace(/^http/, "ws");
      const ref = url.searchParams.get("ref") ?? "";
      const wsUrl =
        `${wsOrigin}/voice/ws?from=${encodeURIComponent(params.To ?? "")}` +
        `&callSid=${encodeURIComponent(params.CallSid ?? "")}&dir=out&ref=${encodeURIComponent(ref)}`;
      return new Response(buildConnectTwiml(wsUrl), { status: 200, headers: { "content-type": "text/xml" } });
    }

    // Final status of an outbound call (call_place, or a call on Sid's behalf).
    // Signed; forwarded to the DO, which tells Jarvis when there's something to
    // act on (no answer, voicemail, how a message call went).
    if (url.pathname === "/voice/status" && request.method === "POST") {
      const params = await formParams(request);
      if (!params) return json({ ok: false, reason: "expected form-encoded body" }, 400);
      const ok = await verifyTwilioSignatureAny(
        env.TWILIO_AUTH_TOKEN,
        twilioSignedUrlCandidates(request.url, env.PUBLIC_ORIGIN),
        params,
        request.headers.get("x-twilio-signature"),
      );
      if (!ok) return json({ ok: false, reason: "bad twilio signature" }, 403);
      const ns = env.JARVIS as DurableObjectNamespace | undefined;
      if (!ns) return json({ ok: false, reason: "JARVIS DO binding missing" }, 500);
      if (!env.OWNER_CHAT_ID) return json({ ok: false, reason: "OWNER_CHAT_ID not configured" }, 500);
      const stub = ns.get(ns.idFromName(env.OWNER_CHAT_ID));
      const body = JSON.stringify({
        ref: url.searchParams.get("ref") ?? "",
        callStatus: params.CallStatus ?? "",
        ...(params.AnsweredBy ? { answeredBy: params.AnsweredBy } : {}),
      });
      const run = stub
        .fetch("https://do/voice/status", { method: "POST", body, headers: { "content-type": "application/json" } })
        .catch((e: unknown) => console.error("call outcome failed:", (e as Error).message));
      if (ctx) ctx.waitUntil(run);
      else await run;
      return new Response(null, { status: 204 });
    }

    // ConversationRelay WebSocket. Twilio signs the handshake (X-Twilio-Signature
    // over the wss:// URL we gave it, which carries `from` and `callSid`). Verify
    // here — fail closed — then hand the socket to the owner's DO, where the
    // relay feeds each utterance to the same brain as Telegram.
    if (url.pathname === "/voice/ws") {
      if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
        return json({ ok: false, reason: "expected a WebSocket upgrade" }, 426);
      }
      const sig = request.headers.get("x-twilio-signature");
      const ok = await verifyTwilioSignatureAny(
        env.TWILIO_AUTH_TOKEN,
        twilioSignedUrlCandidates(request.url, env.PUBLIC_ORIGIN, true),
        {},
        sig,
      );
      if (!ok) return json({ ok: false, reason: "bad twilio signature" }, 403);
      const ns = env.JARVIS as DurableObjectNamespace | undefined;
      if (!ns) return json({ ok: false, reason: "JARVIS DO binding missing" }, 500);
      if (!env.OWNER_CHAT_ID) return json({ ok: false, reason: "OWNER_CHAT_ID not configured" }, 500);
      const stub = ns.get(ns.idFromName(env.OWNER_CHAT_ID));
      return stub.fetch(new Request(`https://do/voice/ws${url.search}`, request));
    }

    // School surface: the 4 routes the School Helper extension dials. Forwarded
    // to the DO raw — the envelope header and exact body bytes must survive.
    if (url.pathname.startsWith("/school/")) {
      const ns = env.JARVIS as DurableObjectNamespace | undefined;
      if (!ns) return json({ ok: false, reason: "JARVIS DO binding missing" }, 500);
      if (!env.OWNER_CHAT_ID) return json({ ok: false, reason: "OWNER_CHAT_ID not configured" }, 500);
      const stub = ns.get(ns.idFromName(env.OWNER_CHAT_ID));
      const headers: Record<string, string> = { "content-type": "application/json" };
      const envelope = request.headers.get(COLLECTOR_ENVELOPE_HEADER);
      if (envelope) headers[COLLECTOR_ENVELOPE_HEADER] = envelope;
      const init: RequestInit = { method: request.method, headers };
      if (request.method === "POST") init.body = await request.text();
      return stub.fetch(`https://do${url.pathname}`, init);
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

    // ---- Sid's Windows PC agent (apps/pc-agent) ----
    // Token-gated, fail closed: without PC_AGENT_TOKEN configured, NOBODY may
    // pull jobs or post results. Jobs and the heartbeat live in D1; when the
    // PC is off its queued work simply waits there.
    if (url.pathname.startsWith("/pc/")) {
      if (request.method !== "POST" && request.method !== "GET") return json({ ok: false, reason: "method not allowed" }, 405);
      const token = bearerToken(request);
      if (!env.PC_AGENT_TOKEN?.trim()) {
        return json({ ok: false, reason: "PC_AGENT_TOKEN is not configured; refusing every PC request" }, 403);
      }
      if (!token || !safeEqual(token, env.PC_AGENT_TOKEN)) {
        return json({ ok: false, reason: "bad or missing bearer token" }, 401);
      }
      const db = env.DB as D1Db | undefined;
      if (!db) return json({ ok: false, reason: "the PC surface needs the DB binding" }, 500);

      if (url.pathname === "/pc/heartbeat" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { version?: string };
        await new D1PcHeartbeatRepo(db, new SystemClock()).record(typeof body.version === "string" ? body.version : undefined);
        return json({ ok: true, note: "heartbeat recorded" });
      }

      if (url.pathname === "/pc/pull") {
        const jobs = await new D1PcJobsRepo(db, new SystemClock()).next(5);
        return json({
          ok: true,
          jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, args: JSON.parse(j.argsJson) as Record<string, unknown> })),
        });
      }

      if (url.pathname === "/pc/result" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as
          | { jobId?: string; ok?: boolean; result?: unknown; error?: string }
          | null;
        if (!body || typeof body.jobId !== "string" || typeof body.ok !== "boolean") {
          return json({ ok: false, reason: "expected { jobId, ok, result?, error? }" }, 400);
        }
        const updated = await new D1PcJobsRepo(db, new SystemClock()).complete(body.jobId, {
          ok: body.ok,
          ...(body.result !== undefined ? { result: body.result } : {}),
          ...(body.error !== undefined ? { error: body.error } : {}),
        });
        if (!updated) return json({ ok: false, reason: `no queued or delivered job with id ${body.jobId}` }, 404);
        // Tell the brain what its PC job actually did (it decides whether to
        // tell Sid). The HTTP answer to the agent still goes back immediately.
        if (env.JARVIS && env.OWNER_CHAT_ID) {
          const stub = (env.JARVIS as DurableObjectNamespace).get(
            (env.JARVIS as DurableObjectNamespace).idFromName(env.OWNER_CHAT_ID),
          );
          const run = stub
            .fetch("https://do/pc/result", {
              method: "POST",
              body: JSON.stringify({ jobId: body.jobId }),
              headers: { "content-type": "application/json" },
            })
            .catch((e: unknown) => console.error("pc result wake failed:", (e as Error).message));
          if (ctx) ctx.waitUntil(run);
        }
        return json({ ok: true, note: "result recorded" });
      }

      return json({ ok: false, reason: "not found" }, 404);
    }

    return json({ ok: false, reason: "not found" }, 404);
  },

  /** Cron entry point. Cloudflare passes the matched cron string in event.cron. */
  async scheduled(event: { cron: string }, env: Env): Promise<void> {
    const ns = env.JARVIS as DurableObjectNamespace | undefined;
    if (!ns || !env.OWNER_CHAT_ID) {
      // Loud, not silent: the external watchdog will also stop getting pings.
      console.error("scheduled: JARVIS binding or OWNER_CHAT_ID missing; cron did nothing");
      return;
    }
    const stub = ns.get(ns.idFromName(env.OWNER_CHAT_ID));
    await stub.fetch(`https://do/cron?expr=${encodeURIComponent(event.cron)}`, { method: "POST" });
  },

  /**
   * Cloudflare Email Routing entry point (school@onesid.ca, with Sid's personal
   * and school inboxes auto-forwarded to it). Parse defensively, archive the
   * untouched .eml to the ARCHIVE bucket, store the parsed row in D1, then wake
   * the brain — via the WORK_QUEUE when bound (slow work belongs on a queue),
   * otherwise directly. No step fakes success; a missing DB rejects the mail so
   * the sender sees a bounce instead of a silent drop.
   */
  async email(message: InboundEmailMessage, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const db = env.DB as D1Db | undefined;
    if (!db) {
      message.setReject("Jarvis has no D1 binding; the email could not be stored. Nothing was done silently.");
      return;
    }
    const raw = await new Response(message.raw).text();
    const accepted = await acceptInboundEmail(
      {
        emails: new D1EmailsRepo(db),
        bucket: env.ARCHIVE ? new R2BucketAdapter(env.ARCHIVE as import("./plumbing/bucket.js").R2Like) : undefined,
        clock: new SystemClock(),
      },
      { raw, envelopeFrom: message.from ?? "", envelopeTo: message.to ?? "" },
    );
    for (const w of accepted.warnings) console.warn(`email ${accepted.email.id}: ${w}`);

    const wake = (async () => {
      const queue = env.WORK_QUEUE as QueueProducerLike | undefined;
      if (queue) {
        await queue.send({ kind: "email", emailId: accepted.email.id });
        return;
      }
      // No queue bound (local dev): deliver straight to the brain, said so.
      console.warn("email: WORK_QUEUE is not bound; waking the brain directly (synchronous path)");
      const ns = env.JARVIS as DurableObjectNamespace | undefined;
      if (!ns || !env.OWNER_CHAT_ID) throw new Error("JARVIS binding or OWNER_CHAT_ID missing; email wake undeliverable");
      const stub = ns.get(ns.idFromName(env.OWNER_CHAT_ID));
      const res = await stub.fetch("https://do/email", {
        method: "POST",
        body: JSON.stringify({ emailId: accepted.email.id }),
        headers: { "content-type": "application/json" },
      });
      if (!res.ok) throw new Error(`DO email wake returned ${res.status}`);
    })();
    if (ctx) ctx.waitUntil(wake.catch((e: unknown) => console.error("email wake failed:", (e as Error).message)));
    else await wake.catch((e: unknown) => console.error("email wake failed:", (e as Error).message));
  },

  /**
   * Queue consumer (jarvis-work). Slow work — email processing today — arrives
   * here so the webhook/email handler can return immediately. A failure is
   * retried up to the platform's attempts; past that it is logged LOUDLY and
   * the row stays in D1 (the email is never lost, only the wake is).
   */
  async queue(batch: { messages: { id: string; body: unknown; attempts: number; ack(): void; retry(opts?: { delaySeconds: number }): void }[] }, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const body = message.body as { kind?: string; emailId?: string };
        if (body?.kind === "email" && typeof body.emailId === "string") {
          const ns = env.JARVIS as DurableObjectNamespace | undefined;
          if (!ns || !env.OWNER_CHAT_ID) throw new Error("JARVIS binding or OWNER_CHAT_ID missing");
          const stub = ns.get(ns.idFromName(env.OWNER_CHAT_ID));
          const res = await stub.fetch("https://do/email", {
            method: "POST",
            body: JSON.stringify({ emailId: body.emailId }),
            headers: { "content-type": "application/json" },
          });
          if (!res.ok) throw new Error(`DO email wake returned ${res.status}`);
        } else {
          // Unknown job: ack it but say so — never a silent drop.
          console.error("queue: unknown message", JSON.stringify(body));
        }
        message.ack();
      } catch (e) {
        if (message.attempts < 5) {
          message.retry({ delaySeconds: 30 });
        } else {
          console.error(`queue: giving up on message ${message.id} after ${message.attempts} attempts:`, (e as Error).message);
          message.ack();
        }
      }
    }
  },
};

async function formParams(request: Request): Promise<Record<string, string> | null> {
  const form = await request.formData().catch(() => null);
  if (!form) return null;
  const params: Record<string, string> = {};
  form.forEach((v, k) => {
    params[k] = String(v);
  });
  return params;
}

function bearerToken(request: Request): string | undefined {
  const h = request.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

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

    // Memory reviews may run on a separate model (brief section 5). Unset => the main model.
    const extractionModel =
      this.env.MEMORY_EXTRACTION_MODEL && this.env.MEMORY_EXTRACTION_MODEL.trim() !== ""
        ? new DeepSeekModel({ apiKey: this.env.DEEPSEEK_API_KEY ?? "", model: this.env.MEMORY_EXTRACTION_MODEL })
        : undefined;

    // Embeddings: Workers AI, or an honest failure. Never the bag-of-words test fake.
    const ai = this.env.AI as { run(model: string, input: unknown): Promise<any> } | undefined;
    const embeddings = ai ? new WorkersAiEmbeddingProvider(ai) : new UnavailableEmbeddingProvider();
    // Vector index: Vectorize (persists across evictions). Without the binding the
    // in-memory index is used and forgets on eviction — facts stay safe in D1 and
    // memory_search reports how many are not indexed.
    const vectors = this.env.MEMORY_VECTORS
      ? new CloudflareVectorizeIndex(this.env.MEMORY_VECTORS as VectorizeLike)
      : new InMemoryVectorIndex();
    const archiveBucket = this.env.ARCHIVE ? new R2BucketAdapter(this.env.ARCHIVE as R2Like) : undefined;
    const backupBucket = this.env.BACKUP ? new R2BucketAdapter(this.env.BACKUP as R2Like) : undefined;
    const storage = this.state.storage as DurableObjectStorageLike;

    const ownerChannel = this.ownerChannels(chatId, async () => {
      const v = await this.built?.settings.get(LAST_TEXT_MEDIUM);
      return v === "telegram" || v === "sms" ? v : undefined;
    });

    // Production storage: D1 when bound, in-memory otherwise (local dev).
    const db = this.env.DB as D1Db | undefined;
    const stores = db
      ? {
          facts: new D1FactsRepo(db, clock),
          conversation: new D1ConversationRepo(db, clock),
          receipts: new D1ReceiptsRepo(db, clock),
          pending: new D1PendingActionsRepo(db, clock),
          settings: new D1SettingsRepo(db),
          appsRepo: new D1ConnectedAppsRepo(db, clock),
          guests: new D1GuestsRepo(db, clock),
          wakeupsRepo: new D1WakeupsRepo(db, clock),
          heartbeat: new D1HeartbeatRepo(db, clock),
          memoryRuns: new D1MemoryRunsRepo(db, clock),
          emails: new D1EmailsRepo(db),
          pcJobs: new D1PcJobsRepo(db, clock),
          pcHeartbeat: new D1PcHeartbeatRepo(db, clock),
        }
      : undefined;

    // Outbound email from Sid's two real accounts (his decision, 2026-09-26).
    // Built when ANY account's credentials exist; a half-configured account
    // reports not_connected per-account, never a fake send.
    const emailSender = this.buildEmailSender();

    this.built = buildJarvis({
      model,
      clock,
      embeddings,
      vectors,
      ownerChannel,
      ownerId: chatId,
      timezone: this.env.OWNER_TIMEZONE ?? "America/Toronto",
      ...(stores ? { stores } : {}),
      ...(db ? { db } : {}),
      ...(extractionModel ? { extractionModel } : {}),
      ...(archiveBucket ? { bucket: archiveBucket } : {}),
      ...(backupBucket ? { backupBucket: backupBucket } : {}),
      ...(emailSender ? { emailSender } : {}),
      ...(this.env.WATCHDOG_PING_URL ? { watchdogUrl: this.env.WATCHDOG_PING_URL } : {}),
      // The ONE Durable Object alarm, always pointed at the earliest wake-up.
      setAlarm: async (fireAtIso) => {
        if (fireAtIso === null) await storage.deleteAlarm();
        else await storage.setAlarm(Date.parse(fireAtIso));
      },
      ...(this.env.OWNER_ACTION_PIN ? { ownerPin: this.env.OWNER_ACTION_PIN } : {}),
      ...(this.env.OWNER_PIN_PEPPER ? { pinPepper: this.env.OWNER_PIN_PEPPER } : {}),
      phone: {
        rest: this.twilio(),
        ...(this.env.OWNER_PHONE_E164?.trim() ? { ownerPhone: this.env.OWNER_PHONE_E164.trim() } : {}),
        ...(this.env.PUBLIC_ORIGIN?.trim() ? { publicOrigin: this.env.PUBLIC_ORIGIN.trim() } : {}),
      },
      textChannels: async () => {
        const last = await this.built?.settings.get(LAST_TEXT_MEDIUM);
        return {
          available: ownerChannel.available(),
          ...(last === "telegram" || last === "sms" ? { lastUsed: last } : {}),
        };
      },
    });
    return this.built;
  }

  /**
   * Sid's text channels. Telegram when its bot token is set; SMS when Twilio
   * (account SID, auth token, from-number) and OWNER_PHONE_E164 are set.
   */
  private ownerChannels(chatId: string, lastUsed: () => Promise<TextMedium | undefined>): OwnerTextChannels {
    const media: Partial<Record<TextMedium, MediumSender>> = {};
    if (this.env.TELEGRAM_BOT_TOKEN?.trim()) {
      const tg = new TelegramChannel(this.env.TELEGRAM_BOT_TOKEN, chatId);
      media.telegram = (m) => tg.sendText(m);
    }
    const twilio = this.twilio();
    const ownerPhone = this.env.OWNER_PHONE_E164?.trim();
    if (twilio.missing() === null && ownerPhone) {
      media.sms = (m) => twilio.sendSms(ownerPhone, m);
    }
    return new OwnerTextChannels(media, lastUsed);
  }

  private twilio(): TwilioRestClient {
    return new TwilioRestClient({
      accountSid: this.env.TWILIO_ACCOUNT_SID,
      authToken: this.env.TWILIO_AUTH_TOKEN,
      fromE164: this.env.TWILIO_FROM_E164,
    });
  }

  /**
   * Outbound email config from secrets. The addresses are Sid's (fixed by his
   * 2026-09-26 decision; env vars exist only to correct them if they change).
   * An account with no credentials is simply absent from the sender — the
   * send_email tool refuses per-account, honestly.
   */
  private buildEmailSender(): EmailSender | undefined {
    const gmail =
      this.env.GMAIL_CLIENT_ID?.trim() && this.env.GMAIL_CLIENT_SECRET?.trim() && this.env.GMAIL_REFRESH_TOKEN?.trim()
        ? {
            provider: "gmail" as const,
            fromAddress: this.env.OWNER_EMAIL_PERSONAL?.trim() || "ksid1229@gmail.com",
            clientId: this.env.GMAIL_CLIENT_ID,
            clientSecret: this.env.GMAIL_CLIENT_SECRET,
            refreshToken: this.env.GMAIL_REFRESH_TOKEN,
          }
        : undefined;
    const graph =
      this.env.MS_GRAPH_CLIENT_ID?.trim() &&
      this.env.MS_GRAPH_CLIENT_SECRET?.trim() &&
      this.env.MS_GRAPH_REFRESH_TOKEN?.trim() &&
      this.env.MS_GRAPH_TENANT_ID?.trim()
        ? {
            provider: "graph" as const,
            fromAddress: this.env.OWNER_EMAIL_SCHOOL?.trim() || "sk7qq09@limestone.on.ca",
            clientId: this.env.MS_GRAPH_CLIENT_ID,
            clientSecret: this.env.MS_GRAPH_CLIENT_SECRET,
            refreshToken: this.env.MS_GRAPH_REFRESH_TOKEN,
            tenantId: this.env.MS_GRAPH_TENANT_ID,
          }
        : undefined;
    if (!gmail && !graph) return undefined;
    return new EmailSender({ ...(gmail ? { personal: gmail } : {}), ...(graph ? { school: graph } : {}) });
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
    if (url.pathname.startsWith("/school/")) {
      return this.handleSchool(request);
    }
    if (url.pathname === "/voice/ws") {
      return this.handleVoiceSocket(url);
    }
    if (url.pathname === "/voice/status") {
      return this.handleCallOutcome(request);
    }
    if (url.pathname === "/email") {
      return this.handleEmailWake(request);
    }
    if (url.pathname === "/pc/result") {
      return this.handlePcResult(request);
    }
    if (url.pathname === "/sms") {
      const sms = (await request.json()) as AcceptedSms;
      return this.handleOwnerText(this.env.OWNER_CHAT_ID ?? "", "sms", {
        text: smsEventText(sms),
        provenance: sms.provenance,
      });
    }
    const update = (await request.json()) as {
      chatId: string;
      text: string;
      provenance: JarvisEvent["provenance"];
      callbackData?: string;
      attachments?: string[];
    };
    return this.handleOwnerText(update.chatId, "telegram", { text: eventTextFor(update), provenance: update.provenance });
  }

  /**
   * One owner text message, from either medium, into the one brain. The reply
   * (or the error) goes back on the medium it came from; that medium is
   * recorded as the one Sid last used.
   */
  private async handleOwnerText(
    chatId: string,
    medium: TextMedium,
    msg: { text: string; provenance: JarvisEvent["provenance"] },
  ): Promise<Response> {
    let built;
    try {
      built = this.ensureBuilt(chatId);
    } catch (e) {
      if (e instanceof MissingModelKeyError) {
        // Say so plainly, on the medium he used; do not pretend to answer.
        const ch = this.ownerChannels(chatId, async () => undefined);
        await ch.sendText("I have no model configured (DEEPSEEK_API_KEY is unset), so I can't answer. Nothing was faked.", medium);
        return json({ ok: false, reason: "no model key" }, 200);
      }
      throw e;
    }
    await built.settings.set(LAST_TEXT_MEDIUM, medium);

    const event: JarvisEvent = {
      channel: "text",
      trigger: "text",
      provenance: { ...msg.provenance, medium },
      text: msg.text,
      eventId: newId("evt"),
    };

    const result = await built.agent.handle(event);

    // Deliver the reply. A failed send is surfaced in the response, not hidden.
    if (result.error) {
      await built.ownerChannel.sendText(`Something went wrong reaching the model: ${result.error}`, medium);
      return json({ ok: false, reason: result.error }, 200);
    }
    if (result.reply.trim() !== "") {
      const send = await built.ownerChannel.sendText(result.reply, medium);
      return json({ ok: send.ok, sendStatus: send.status, via: send.via });
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
    const app = await built.appsRepo.byName(String(body.appName ?? ""));
    // Verify the app is registered and the secret matches. Fail closed.
    if (!app || !body.authSecret || body.authSecret !== app.authSecret) {
      return json({ ok: false, reason: "unknown app or bad secret" }, 401);
    }
    const db = this.env.DB as D1Db | undefined;
    const events = db
      ? new D1AppEventsRepo(db, new SystemClock())
      : new AppEventsRepo(new SystemClock());
    const ev = await events.store(app.name, body.payload);
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
      reviewer: built.reviewer,
      reindex: built.reindex,
    });
    if (result.wakeupsFailed.length > 0 || result.memoryReview?.status === "error" || result.hourlyCheck?.ok === false) {
      console.error("cron: failures", JSON.stringify(result));
    }
    return json({ ok: true, result });
  }

  /**
   * Durable Object alarm: fires every due wake-up (Sid's reminders and the
   * quiet-conversation memory review) at its time, not up to an hour late on
   * the next cron. A failed wake-up stays queued and the scheduler re-arms the
   * alarm with a retry floor; failures are logged, never dropped.
   */
  async alarm(): Promise<void> {
    const ownerId = this.env.OWNER_CHAT_ID;
    if (!ownerId) {
      console.error("alarm: OWNER_CHAT_ID not configured; wake-ups cannot run");
      return;
    }
    let built;
    try {
      built = this.ensureBuilt(ownerId);
    } catch (e) {
      console.error("alarm: cannot build Jarvis:", (e as Error).message);
      throw e; // Cloudflare retries a throwing alarm with backoff.
    }
    await built.heartbeat.record("alarm");
    const res = await built.wakeups.fireDue((w) => fireWakeup(w, { agent: built.agent, reviewer: built.reviewer }));
    if (res.failed.length > 0) console.error("alarm: wake-ups failed and stay queued", JSON.stringify(res.failed));
  }

  /**
   * Accept the (already signature-verified) ConversationRelay socket and run
   * the voice relay on it. The socket is accepted directly (not hibernated) so
   * the per-call session — role, PIN state, guest transcript — lives in memory
   * for exactly the length of the call and vanishes with it.
   */
  /**
   * An inbound email woke the brain (via the queue, or directly when no queue
   * is bound). The model DECIDES what the email means, whether to interrupt
   * Sid and what to remember — code only hands it the words (capped, with the
   * drop count said) and marks the email reviewed.
   */
  private async handleEmailWake(request: Request): Promise<Response> {
    const body = (await request.json()) as { emailId?: string };
    const ownerId = this.env.OWNER_CHAT_ID ?? "";
    let built;
    try {
      built = this.ensureBuilt(ownerId);
    } catch (e) {
      if (e instanceof MissingModelKeyError) {
        console.error(`email wake for ${body.emailId}: no model key; the email stays stored and unreviewed`);
        return json({ ok: false, reason: "no model key" }, 200);
      }
      throw e;
    }
    const email = body.emailId ? await built.emails.get(body.emailId) : undefined;
    if (!email) {
      return json({ ok: false, reason: `no email with id ${body.emailId}` }, 404);
    }
    const result = await built.agent.handle({
      channel: "text",
      trigger: "email",
      eventId: newId("evt"),
      text: wakeTextFor(email),
      provenance: {
        channel: "text",
        // An email that auto-forwarded into Jarvis is not Sid's own words.
        isOwner: false,
        isForwarded: true,
        isPrivate: true,
        sourceRef: `email:${email.id}`,
        sourceType: "email",
      },
    });
    await built.emails.markReviewed(email.id, new SystemClock().nowIso());
    if (result.error) {
      console.error(`email wake for ${email.id}: model error ${result.error}`);
      return json({ ok: false, reason: result.error }, 200);
    }
    // The model was free to send_text Sid itself; whatever it replied goes on
    // his text channels too (the wake is not a reply to anything he sent).
    if (result.reply.trim() !== "") await built.ownerChannel.sendText(result.reply);
    return json({ ok: true });
  }

  /**
   * A job Jarvis queued on Sid's PC finished (the PC agent posted its result).
   * The model decides whether that's worth telling Sid; the receipt already
   * proves what the PC actually did.
   */
  private async handlePcResult(request: Request): Promise<Response> {
    const body = (await request.json()) as { jobId?: string };
    const ownerId = this.env.OWNER_CHAT_ID ?? "";
    let built;
    try {
      built = this.ensureBuilt(ownerId);
    } catch (e) {
      if (e instanceof MissingModelKeyError) return json({ ok: false, reason: "no model key" }, 200);
      throw e;
    }
    if (!built.pcJobs) return json({ ok: false, reason: "PC surface is not wired" }, 500);
    const job = body.jobId ? await built.pcJobs.get(body.jobId) : undefined;
    if (!job) return json({ ok: false, reason: `no pc job with id ${body.jobId}` }, 404);

    let what: string;
    if (job.status === "done") {
      what = `finished successfully. Result: ${job.resultJson ?? "(none)"}`;
    } else if (job.status === "failed") {
      what = `FAILED. Error: ${job.error ?? "(none)"}`;
    } else {
      what = `is still ${job.status} (no result was posted for it).`;
    }
    const result = await built.agent.handle({
      channel: "text",
      trigger: "app_event",
      eventId: newId("evt"),
      text:
        `[pc result] The ${job.kind} job you queued on Sid's PC at ${job.createdAt} (id ${job.id}) ${what} ` +
        "Decide whether Sid needs to hear about this and how (text him, stay quiet, retry, ...). The full receipt is in receipts_query.",
      provenance: {
        channel: "text",
        isOwner: false,
        isForwarded: false,
        isPrivate: true,
        sourceRef: `pc:job:${job.id}`,
        sourceType: "app",
      },
    });
    if (!result.error && result.reply.trim() !== "") await built.ownerChannel.sendText(result.reply);
    return json({ ok: !result.error });
  }

  /** An outbound call ended: tell Jarvis when there's something to act on. */
  private async handleCallOutcome(request: Request): Promise<Response> {
    const body = (await request.json()) as { ref: string; callStatus: string; answeredBy?: string };
    const ownerId = this.env.OWNER_CHAT_ID ?? "";
    let built;
    try {
      built = this.ensureBuilt(ownerId);
    } catch (e) {
      if (e instanceof MissingModelKeyError) return json({ ok: false, reason: "no model key" }, 200);
      throw e;
    }
    const rec = await recallOutbound(built.settings, body.ref);
    await built.receipts.log({
      tool: "call_outcome",
      input: { ref: body.ref, purpose: rec?.purpose ?? null },
      result: { callStatus: body.callStatus, answeredBy: body.answeredBy ?? null },
      trigger: "wakeup",
      performed: false,
      status: body.callStatus || "unknown",
    });
    const text = describeCallOutcome(rec, body.ref, body.callStatus, body.answeredBy);
    if (text === null) return json({ ok: true, note: "answered; nothing to report" });
    const wake = await built.agent.handle({
      channel: "text",
      trigger: "wakeup",
      eventId: newId("evt"),
      text,
      provenance: {
        channel: "text",
        isOwner: false,
        isForwarded: false,
        isPrivate: true,
        sourceRef: `twilio:call-outcome:${body.ref}`,
        sourceType: "call",
      },
    });
    if (!wake.error && wake.reply.trim() !== "") await built.ownerChannel.sendText(wake.reply);
    return json({ ok: !wake.error });
  }

  private async handleVoiceSocket(url: URL): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const send = (m: unknown) => {
      try {
        server.send(JSON.stringify(m));
      } catch (e) {
        console.error("voice relay: send failed", (e as Error).message);
      }
    };

    const ownerId = this.env.OWNER_CHAT_ID ?? "";
    let built;
    try {
      built = this.ensureBuilt(ownerId);
    } catch (e) {
      // No model: say so on the call and hang up. Never a fake conversation.
      const line =
        e instanceof MissingModelKeyError
          ? "Jarvis has no model configured, so I can't talk right now. Nothing was done."
          : "Jarvis could not start, so I can't talk right now. Nothing was done.";
      server.addEventListener("message", () => {
        send({ type: "text", token: line, last: true });
        send({ type: "end", handoffData: JSON.stringify({ reason: "jarvis unavailable" }) });
      });
      console.error("voice relay: cannot build Jarvis:", (e as Error).message);
      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: CfWebSocket });
    }

    // Outbound (call_place / make_call): the signed URL carries dir=out and the
    // call's ref. A two-way call (make_call) becomes an EXTERNAL session — a
    // third party with a minimal prompt carrying only the confirmed brief.
    const outbound = url.searchParams.get("dir") === "out";
    const outboundRec = outbound
      ? await recallOutbound(built.settings, url.searchParams.get("ref") ?? "")
      : undefined;
    const twoWay: OutboundCallRecord | undefined = outboundRec?.purpose === "two_way" ? outboundRec : undefined;
    const relay = new VoiceRelay({
      ...(outbound ? { direction: "outbound" as const } : {}),
      ...(outbound && !twoWay ? { outboundReason: outboundRec?.text ?? null } : {}),
      ...(twoWay ? { external: { to: twoWay.to, brief: twoWay.text } } : {}),
      agent: built.agent,
      guests: built.guests,
      receipts: built.receipts,
      clock: new SystemClock(),
      ownerPhoneE164: this.env.OWNER_PHONE_E164,
      ownerPinVerifier: built.ownerPinVerifier,
      pinPepper: this.env.OWNER_PIN_PEPPER,
      signedFrom: url.searchParams.get("from") ?? "",
      signedCallSid: url.searchParams.get("callSid") ?? "",
      send,
      close: (code, reason) => {
        try {
          server.close(code, reason);
        } catch {
          /* already closed */
        }
      },
      newEventId: () => newId("evt"),
    });
    server.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      const done = relay.onMessage(raw);
      this.state.waitUntil?.(done);
    });
    server.addEventListener("close", () => {
      const done = relay.onClose().then(async (info) => {
        if (!info?.external) return;
        // A two-way (make_call) conversation ended. The transcript is already
        // stored as a receipt; wake the brain with the summary so it can tell
        // Sid how the call went (and read the transcript via receipts_query).
        const wake = await built.agent.handle({
          channel: "text",
          trigger: "call",
          eventId: newId("evt"),
          text:
            `[external call ended] Your two-way call to ${info.external.to} (brief: "${info.external.brief}") ended ` +
            `after ${info.turns} turn(s). The full transcript is stored as a receipt — query receipts for tool ` +
            "'call_transcript' to read exactly what was said before telling Sid how it went.",
          provenance: {
            channel: "text",
            isOwner: false,
            isForwarded: false,
            isPrivate: true,
            sourceRef: `twilio:external:${info.callSid}`,
            sourceType: "call",
          },
        });
        if (!wake.error && wake.reply.trim() !== "") await built.ownerChannel.sendText(wake.reply);
      });
      this.state.waitUntil?.(done);
    });
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: CfWebSocket });
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
    const school = built.school ? await schoolVaultSnapshot(built.school.evidence, new Date()) : undefined;
    const exported = buildVaultExport(await built.facts.all(), await built.wakeupsRepo.list(), {
      isActive: (f) => built.facts.isActive(f),
      ...(school ? { school } : {}),
    });
    return json({
      ok: true,
      count: exported.count,
      notes: exported.notes,
      ...(exported.schoolUnreadable ? { schoolUnreadable: exported.schoolUnreadable } : {}),
    });
  }

  private async handleSchool(request: Request): Promise<Response> {
    // The school surface requires D1: keys, nonces, evidence and the request
    // queue have no in-memory fallback. Fail closed without it.
    const db = this.env.DB as D1Db | undefined;
    if (!db) return json({ ok: false, reason: "school surface needs the DB binding" }, 500);
    const ownerId = this.env.OWNER_CHAT_ID ?? "";
    if (!ownerId) return json({ ok: false, reason: "OWNER_CHAT_ID not configured" }, 500);
    const url = new URL(request.url);
    const rawBody = await request.text();
    const result = await handleSchoolRequest(request.method, url.pathname, request.headers, rawBody, {
      db,
      ownerId,
      nowMs: () => Date.now(),
    });
    if (result.pairing) {
      // A pairing started: wake the brain so it can ask Sid for the code.
      // The HTTP answer still goes back to the app untouched.
      try {
        const built = this.ensureBuilt(ownerId);
        const wake = await built.agent.handle({
          channel: "text",
          trigger: "app_event",
          eventId: newId("evt"),
          text:
            `A School Helper pairing started on '${result.pairing.deviceLabel}'. ` +
            `If Sid gives you the 6-digit code, approve it with school_collector_approve. ` +
            `The code expires at ${result.pairing.expiresAt}. Only a code Sid himself gives you counts.`,
          provenance: {
            channel: "text",
            isOwner: false,
            isForwarded: false,
            isPrivate: true,
            sourceRef: `school:pairing:${result.pairing.collectorId}`,
            sourceType: "app",
          },
        });
        if (!wake.error && wake.reply.trim() !== "") {
          // Not a reply to anything Sid sent: the channel uses his last medium.
          await built.ownerChannel.sendText(wake.reply);
        }
      } catch (e) {
        if (!(e instanceof MissingModelKeyError)) throw e;
        // No model: the pairing still stands; Sid just gets no pro-active text.
      }
    }
    return json(result.body, result.status);
  }
}

/** The slice of DurableObjectStorage used for the single alarm. */
interface DurableObjectStorageLike {
  setAlarm(scheduledTimeMs: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
