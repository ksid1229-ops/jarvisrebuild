import { describe, expect, it } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { fakeToolCall } from "../src/model/fake-model.js";
import { CONFIRMATION_TTL_MS } from "../src/confirmations/pending-actions.js";

describe("Phase 4: the five confirmed actions", () => {
  it("holds a confirmable action as pending and does NOT execute it on first call", async () => {
    const h = makeHarness([
      {
        content: "",
        toolCalls: [
          fakeToolCall("send_email", { to: "p@x.com", subject: "Hi", body: "Body" }),
        ],
      },
      { content: "I've asked you to confirm that email." },
    ]);
    await h.agent.handle(ownerEvent("email my prof", "e1"));
    // Sid received a confirmation prompt.
    expect(h.ownerChannel.sent.some((m) => m.startsWith("Just to be sure"))).toBe(true);
    // The action did NOT run: no not_connected receipt from send_email execution.
    const executed = (await h.receipts.all()).find((r) => r.tool === "send_email" && r.status === "not_connected");
    expect(executed).toBeUndefined();
    // A confirmation_requested receipt exists.
    expect((await h.receipts.all()).some((r) => r.tool === "send_email" && r.status === "confirmation_requested")).toBe(true);
  });

  it("refuses to self-confirm within the same turn that requested it", async () => {
    const h = makeHarness([
      { content: "", toolCalls: [fakeToolCall("send_email", { to: "p@x.com", subject: "Hi", body: "B" })] },
      { content: "waiting" },
    ]);
    await h.agent.handle(ownerEvent("email prof", "e1"));
    const pendingId = [...(h.pending as any).actions.keys()][0] as string;
    const sameTurnCtx = h.ctxFor(ownerEvent("(same turn)", "e1"));
    const res = await h.dispatcher.executeConfirmed(pendingId, sameTurnCtx);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("must come from Sid");
  });

  it("executes only after Sid confirms in a later turn, and is honest that it is not connected", async () => {
    const h = makeHarness([
      { content: "", toolCalls: [fakeToolCall("send_email", { to: "p@x.com", subject: "Hi", body: "B" })] },
      { content: "waiting" },
    ]);
    await h.agent.handle(ownerEvent("email prof", "e1"));
    const pendingId = [...(h.pending as any).actions.keys()][0] as string;

    const laterCtx = h.ctxFor(ownerEvent("yes send it", "e2"));
    const res = await h.dispatcher.executeConfirmed(pendingId, laterCtx);
    // Not connected: honest, not faked success.
    expect(res.status).toBe("not_connected");
    expect(res.ok).toBe(false);
    const receipt = (await h.receipts.all()).find((r) => r.tool === "send_email" && r.status === "not_connected");
    expect(receipt).toBeTruthy();
    expect(receipt!.performed).toBe(false);
  });

  it("binds a confirmation to exact arguments: a changed action gets a new pending, not the old one", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx1 = h.ctxFor(ownerEvent("spend", "e1"));
    await h.dispatcher.dispatch("spend_money", { amount: 5, currency: "CAD", description: "coffee" }, ctx1);
    const ctx2 = h.ctxFor(ownerEvent("spend more", "e1b"));
    await h.dispatcher.dispatch("spend_money", { amount: 50, currency: "CAD", description: "coffee" }, ctx2);
    const actions = [...(h.pending as any).actions.values()] as any[];
    expect(actions).toHaveLength(2);
    expect(actions[0].argsHash).not.toBe(actions[1].argsHash);
  });

  it("shadow mode logs what it WOULD do and does not execute", async () => {
    const h = makeHarness([{ content: "x" }]);
    await h.settings.set("shadow", "on");
    const ctx1 = h.ctxFor(ownerEvent("spend", "e1"));
    await h.dispatcher.dispatch("spend_money", { amount: 5, currency: "CAD", description: "coffee" }, ctx1);
    const pendingId = [...(h.pending as any).actions.keys()][0] as string;
    const ctx2 = h.ctxFor(ownerEvent("yes", "e2"));
    const res = await h.dispatcher.executeConfirmed(pendingId, ctx2);
    expect(res.status).toBe("shadow");
    expect(res.message).toContain("would have done");
    // The real action never ran (no not_connected receipt).
    expect((await h.receipts.all()).some((r) => r.tool === "spend_money" && r.status === "not_connected")).toBe(false);
  });

  it("expires a confirmation after the TTL", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx1 = h.ctxFor(ownerEvent("spend", "e1"));
    await h.dispatcher.dispatch("spend_money", { amount: 5, currency: "CAD", description: "coffee" }, ctx1);
    const pendingId = [...(h.pending as any).actions.keys()][0] as string;
    h.clock.advance(CONFIRMATION_TTL_MS + 1000);
    const ctx2 = h.ctxFor(ownerEvent("yes", "e2"));
    const res = await h.dispatcher.executeConfirmed(pendingId, ctx2);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("expired");
  });

  it("receipts_query returns proof of what actually happened", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx = h.ctxFor(ownerEvent("do things", "e1"));
    await h.dispatcher.dispatch("send_text", { message: "hi", via: "telegram" }, ctx);
    const res = await h.dispatcher.dispatch("receipts_query", {}, ctx);
    const rows = res.data as any[];
    expect(rows.some((r) => r.tool === "send_text" && r.performed === true)).toBe(true);
  });
});
