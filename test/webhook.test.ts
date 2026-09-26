import { describe, expect, it } from "vitest";
import { verifyTelegramWebhook } from "../src/router/telegram-webhook.js";
import type { Env } from "../src/env.js";

const goodEnv: Env = {
  TELEGRAM_WEBHOOK_SECRET: "s3cret",
  OWNER_CHAT_ID: "12345",
};

function ownerMessage(text: string) {
  return { message: { message_id: 7, chat: { id: 12345, type: "private" }, text } };
}

describe("Telegram webhook: senses + fail-closed guards", () => {
  it("fails closed when the webhook secret is not configured", () => {
    const d = verifyTelegramWebhook("anything", ownerMessage("hi"), { OWNER_CHAT_ID: "12345" });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(500);
    expect(d.reason).toContain("TELEGRAM_WEBHOOK_SECRET");
  });

  it("rejects a wrong secret header", () => {
    const d = verifyTelegramWebhook("wrong", ownerMessage("hi"), goodEnv);
    expect(d.ok).toBe(false);
    expect(d.status).toBe(401);
  });

  it("fails closed when no owner chat id is configured (never treats everyone as owner)", () => {
    const d = verifyTelegramWebhook("s3cret", ownerMessage("hi"), { TELEGRAM_WEBHOOK_SECRET: "s3cret" });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(500);
    expect(d.reason).toContain("OWNER_CHAT_ID");
  });

  it("does not process a non-owner chat as owner", () => {
    const foreign = { message: { message_id: 1, chat: { id: 99999, type: "private" }, text: "hi" } };
    const d = verifyTelegramWebhook("s3cret", foreign, goodEnv);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("not owner");
    expect(d.update).toBeUndefined();
  });

  it("accepts the owner and sets provenance from the channel", () => {
    const d = verifyTelegramWebhook("s3cret", ownerMessage("hello"), goodEnv);
    expect(d.ok).toBe(true);
    expect(d.update!.text).toBe("hello");
    expect(d.update!.provenance.isOwner).toBe(true);
    expect(d.update!.provenance.isPrivate).toBe(true);
    expect(d.update!.provenance.isForwarded).toBe(false);
    expect(d.update!.provenance.sourceRef).toBe("telegram:12345:7");
  });

  it("marks forwarded messages as forwarded (provenance the model cannot see itself)", () => {
    const fwd = {
      message: { message_id: 8, chat: { id: 12345, type: "private" }, text: "look at this", forward_date: 111 },
    };
    const d = verifyTelegramWebhook("s3cret", fwd, goodEnv);
    expect(d.ok).toBe(true);
    expect(d.update!.provenance.isForwarded).toBe(true);
  });

  it("marks a group chat as not private", () => {
    const group = { message: { message_id: 9, chat: { id: 12345, type: "group" }, text: "hi" } };
    const d = verifyTelegramWebhook("s3cret", group, goodEnv);
    expect(d.update!.provenance.isPrivate).toBe(false);
  });

  it("classifies an inline button tap as a structured callback (confirmation path)", () => {
    const tap = {
      callback_query: { id: "cbq1", data: "confirm:pending_x", message: { chat: { id: 12345, type: "private" } } },
    };
    const d = verifyTelegramWebhook("s3cret", tap, goodEnv);
    expect(d.ok).toBe(true);
    expect(d.update!.callbackData).toBe("confirm:pending_x");
  });
});
