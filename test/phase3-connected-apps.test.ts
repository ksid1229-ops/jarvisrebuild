import { describe, expect, it } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { fakeToolCall } from "../src/model/fake-model.js";
import { FakeApp } from "../src/apps/fake-app.js";
import { wakeOnAppEvent, AppEventsRepo } from "../src/apps/app-events.js";
import type { ConnectedApp } from "../src/types.js";

function withFakeApp() {
  const app = new FakeApp("testapp");
  const makeConnector = (_a: ConnectedApp) => app;
  return { app, makeConnector };
}

describe("Phase 3: connected apps (the plug)", () => {
  it("connects an app from one message (via confirmed connect_app) and loads its tools", async () => {
    const { app, makeConnector } = withFakeApp();
    const h = makeHarness(
      [
        { content: "", toolCalls: [fakeToolCall("connect_app", { name: "testapp", base_url: "https://x", auth_secret: "s" })] },
        { content: "Asked you to confirm connecting testapp." },
      ],
      { makeConnector },
    );
    await h.agent.handle(ownerEvent("connect my test app", "e1"));
    // connect_app is confirmable: held pending, not executed yet.
    expect(h.dispatcher.has("testapp.get_status")).toBe(false);
    const pendingId = [...(h.pending as any).actions.keys()][0] as string;

    // Sid confirms in a later turn -> app connects and tools load.
    const laterCtx = h.ctxFor(ownerEvent("yes connect it", "e2"));
    const res = await h.dispatcher.executeConfirmed(pendingId, laterCtx);
    expect(res.status).toBe("ok");
    expect(h.dispatcher.has("testapp.get_status")).toBe(true);
    expect(h.dispatcher.has("testapp.submit_thing")).toBe(true);
    void app;
  });

  it("an app tool works on BOTH text and a phone call (same catalogue)", async () => {
    const { app, makeConnector } = withFakeApp();
    const h = makeHarness([], { makeConnector });
    await h.apps.connect({ name: "testapp", baseUrl: "https://x", authSecret: "s" });

    // Text channel call.
    const textCtx = h.ctxFor(ownerEvent("status?", "t1"));
    const r1 = await h.dispatcher.dispatch("testapp.get_status", {}, textCtx);
    expect(r1.ok).toBe(true);
    expect((r1.data as any).status).toBe("green");

    // Voice channel call — identical tool, identical result.
    const voiceCtx = h.ctxFor(ownerEvent("status?", "c1", { channel: "voice", trigger: "call" }));
    const r2 = await h.dispatcher.dispatch("testapp.get_status", {}, voiceCtx);
    expect(r2.ok).toBe(true);
    expect(app.calls.filter((c) => c.name === "get_status")).toHaveLength(2);
  });

  it("an app tool declared confirmable routes through Jarvis's enforced confirmation", async () => {
    const { app, makeConnector } = withFakeApp();
    const h = makeHarness([], { makeConnector });
    await h.apps.connect({ name: "testapp", baseUrl: "https://x", authSecret: "s" });

    const ctx1 = h.ctxFor(ownerEvent("submit", "e1"));
    const first = await h.dispatcher.dispatch("testapp.submit_thing", { thing: "essay" }, ctx1);
    expect(first.status).toBe("confirmation_requested");
    // The app was NOT called yet.
    expect(app.calls.some((c) => c.name === "submit_thing")).toBe(false);

    const pendingId = [...(h.pending as any).actions.keys()][0] as string;
    const ctx2 = h.ctxFor(ownerEvent("yes", "e2"));
    const done = await h.dispatcher.executeConfirmed(pendingId, ctx2);
    expect(done.ok).toBe(true);
    expect(app.calls.some((c) => c.name === "submit_thing")).toBe(true);
  });

  it("an app event wakes Jarvis, which decides on its own whether to tell Sid", async () => {
    const { makeConnector } = withFakeApp();
    // The model, on the wake-up, decides to notify Sid via send_text.
    const h = makeHarness(
      [
        { content: "", toolCalls: [fakeToolCall("send_text", { message: "Heads up: testapp says something changed.", via: "telegram" })] },
        { content: "" },
      ],
      { makeConnector },
    );
    await h.apps.connect({ name: "testapp", baseUrl: "https://x", authSecret: "s" });

    const events = new AppEventsRepo(h.clock);
    const ev = await events.store("testapp", { changed: true });
    await wakeOnAppEvent(h.agent, ev, "sid");

    expect(h.ownerChannel.sent.some((m) => m.includes("testapp"))).toBe(true);
    // The wake-up carries the app name + raw payload to the model.
    const wakeMsg = h.model.requests[0]!.messages.find((m) => m.content.includes("Event from connected app"));
    expect(wakeMsg).toBeTruthy();
    expect(wakeMsg!.content).toContain("testapp");
  });

  it("failure is visible: a down app returns an honest error, not a fake success", async () => {
    const { app, makeConnector } = withFakeApp();
    const h = makeHarness([], { makeConnector });
    await h.apps.connect({ name: "testapp", baseUrl: "https://x", authSecret: "s" });
    app.reachable = false;
    const ctx = h.ctxFor(ownerEvent("status?", "t1"));
    const r = await h.dispatcher.dispatch("testapp.get_status", {}, ctx);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("app_unreachable");
    const receipt = (await h.receipts.all()).find((x) => x.tool === "testapp.get_status");
    expect(receipt!.performed).toBe(false);
  });

  it("a fact learned from an app event is stored with the app as its source", async () => {
    const h = makeHarness([{ content: "x" }]);
    const ctx = h.ctxFor({
      channel: "text",
      trigger: "app_event",
      eventId: "ae1",
      text: "grade posted: 88 in Chemistry",
      provenance: {
        channel: "text",
        isOwner: true,
        isForwarded: false,
        isPrivate: true,
        sourceRef: "app:school:evt1",
        sourceType: "app",
      },
    });
    const { memorySave } = await import("../src/memory/memory-tools.js");
    await memorySave.run({ text: "Sid got 88 in Chemistry", kind: "durable", confidence: "inferred" }, ctx);
    const f = (await h.facts.activeFacts())[0]!;
    expect(f.sourceType).toBe("app");
    expect(f.sourceRef).toBe("app:school:evt1");
  });
});
