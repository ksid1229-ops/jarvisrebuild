import type { Env } from "../env.js";
import type { Provenance } from "../types.js";

export interface AcceptedTelegramUpdate {
  chatId: string;
  messageId: string;
  text: string;
  provenance: Provenance;
  /** Present when this update is an inline button tap (structured confirmation path). */
  callbackData?: string;
}

export interface WebhookDecision {
  ok: boolean;
  status: number;
  reason?: string;
  update?: AcceptedTelegramUpdate;
}

/** Timing-safe string compare (avoids leaking secret length/prefix via timing). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify and classify a Telegram webhook update. FAILS CLOSED:
 *  - no webhook secret configured  -> 500, refuse (never accept unauthenticated).
 *  - header secret mismatch         -> 401, refuse.
 *  - no owner chat id configured    -> 500, refuse (never treat everyone as owner).
 *  - update from a non-owner chat   -> 200 ack but not processed as owner.
 *
 * Provenance (senses) is set here from the channel, not by the model.
 */
export function verifyTelegramWebhook(
  secretHeader: string | null,
  body: any,
  env: Env,
): WebhookDecision {
  if (!env.TELEGRAM_WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET.trim() === "") {
    return { ok: false, status: 500, reason: "TELEGRAM_WEBHOOK_SECRET is not configured; refusing." };
  }
  if (!secretHeader || !safeEqual(secretHeader, env.TELEGRAM_WEBHOOK_SECRET)) {
    return { ok: false, status: 401, reason: "webhook secret mismatch" };
  }
  if (!env.OWNER_CHAT_ID || env.OWNER_CHAT_ID.trim() === "") {
    return { ok: false, status: 500, reason: "OWNER_CHAT_ID is not configured; refusing to treat anyone as owner." };
  }

  const callback = body?.callback_query;
  const msg = body?.message ?? callback?.message;
  if (!msg?.chat) {
    return { ok: true, status: 200, reason: "no message to process" };
  }
  const chatId = String(msg.chat.id);
  const isOwner = safeEqual(chatId, env.OWNER_CHAT_ID);
  if (!isOwner) {
    // Ack so Telegram stops retrying, but do not process as owner.
    return { ok: false, status: 200, reason: "not owner" };
  }

  const isForwarded = Boolean(msg.forward_origin || msg.forward_from || msg.forward_date);
  const isPrivate = msg.chat.type === "private";
  const messageId = String(callback?.id ?? msg.message_id ?? "");
  const text = String(callback?.data ?? msg.text ?? "");

  const provenance: Provenance = {
    channel: "text",
    isOwner: true,
    isForwarded,
    isPrivate,
    sourceRef: `telegram:${chatId}:${messageId}`,
    sourceType: "conversation",
  };

  return {
    ok: true,
    status: 200,
    update: {
      chatId,
      messageId,
      text,
      provenance,
      ...(callback ? { callbackData: String(callback.data ?? "") } : {}),
    },
  };
}
