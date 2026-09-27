import { describe, expect, it } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { fakeToolCall } from "../src/model/fake-model.js";

describe("Phase 1: the nervous system", () => {
  it("replies to a text and stores both sides of the conversation", async () => {
    const h = makeHarness([{ content: "Hey Sid." }]);
    const res = await h.agent.handle(ownerEvent("hello"));
    expect(res.reply).toBe("Hey Sid.");
    const msgs = await h.conversation.all();
    expect(msgs.map((m) => `${m.role}:${m.content}`)).toEqual(["user:hello", "assistant:Hey Sid."]);
  });

  it("remembers earlier in the conversation (history is sent to the model)", async () => {
    const h = makeHarness([{ content: "Hi." }, { content: "You said hello first." }]);
    await h.agent.handle(ownerEvent("hello", "e1"));
    await h.agent.handle(ownerEvent("what did I say?", "e2"));
    const secondRequest = h.model.requests[1]!;
    const contents = secondRequest.messages.map((m) => m.content);
    expect(contents).toContain("hello");
    expect(contents).toContain("Hi.");
  });

  it("injects the current date, time and Sid's timezone into every turn", async () => {
    const h = makeHarness([{ content: "ok" }]);
    await h.agent.handle(ownerEvent("hi"));
    const system = h.model.requests[0]!.messages[0]!.content;
    expect(system).toContain("America/Toronto");
    expect(system).toContain("2026");
    expect(system).toContain("2026-09-26T12:00:00.000Z");
  });

  it("logs every tool call as a receipt with its trigger", async () => {
    const h = makeHarness([
      { content: "", toolCalls: [fakeToolCall("send_text", { message: "proactive hi", via: "telegram" })] },
      { content: "done" },
    ]);
    await h.agent.handle(ownerEvent("ping"));
    const r = (await h.receipts.all()).find((x) => x.tool === "send_text");
    expect(r).toBeTruthy();
    expect(r!.trigger).toBe("text");
    expect(r!.performed).toBe(true);
  });

  it("surfaces and logs an empty reply instead of dropping it silently", async () => {
    const h = makeHarness([{ content: "" }]);
    const res = await h.agent.handle(ownerEvent("hi"));
    expect(res.reply).toBe("");
    const empty = (await h.receipts.all()).find((r) => r.status === "empty_reply");
    expect(empty).toBeTruthy();
    // An empty reply is not stored as an assistant message.
    expect((await h.conversation.all()).some((m) => m.role === "assistant")).toBe(false);
  });

  it("surfaces and logs a model error rather than swallowing it", async () => {
    const h = makeHarness([
      () => {
        throw new Error("deepseek exploded");
      },
    ]);
    const res = await h.agent.handle(ownerEvent("hi"));
    expect(res.error).toContain("deepseek exploded");
    const err = (await h.receipts.all()).find((r) => r.tool === "model" && r.status === "error");
    expect(err).toBeTruthy();
  });

  it("send_text surfaces a failed delivery honestly", async () => {
    const h = makeHarness([
      { content: "", toolCalls: [fakeToolCall("send_text", { message: "hi", via: "sms" })] },
      { content: "noted the failure" },
    ]);
    h.ownerChannel.failNext = true;
    await h.agent.handle(ownerEvent("ping"));
    const r = (await h.receipts.all()).find((x) => x.tool === "send_text");
    expect(r!.performed).toBe(false);
    expect(r!.status).toBe("send_failed");
  });
});
