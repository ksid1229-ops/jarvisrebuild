import { describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock.js";
import { parseEmail, htmlToText } from "../src/email/mime.js";
import { acceptInboundEmail, wakeTextFor, EMAIL_EXCERPT_CAP } from "../src/email/email-worker.js";
import { InMemoryEmailsRepo } from "../src/email/email-repo.js";
import { EmailSender, type EmailOutConfig } from "../src/email/outbound.js";
import { InMemoryBucket } from "../src/plumbing/bucket.js";
import worker from "../src/index.js";
import { freshDb } from "./d1-testkit.js";
import { D1EmailsRepo } from "../src/email/email-repo.js";
import { makeHarness, ownerEvent } from "./helpers.js";
import { fakeToolCall } from "../src/model/fake-model.js";
import { JarvisDurableObject } from "../src/index.js";
import type { Env } from "../src/env.js";

// ---------------------------------------------------------------------------
// MIME parsing (defensive; nothing faked, warnings surfaced)
// ---------------------------------------------------------------------------

describe("email: MIME parser", () => {
  it("reads a simple text/plain email with folded headers", () => {
    const raw = [
      "From: Teacher <t@limestone.on.ca>",
      "To: school@onesid.ca",
      "Subject: Assignment 2",
      "  extension",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Due Friday. Late submissions lose 10%.",
    ].join("\r\n");
    const parsed = parseEmail(raw);
    expect(parsed.subject).toBe("Assignment 2 extension");
    expect(parsed.from).toBe("Teacher <t@limestone.on.ca>");
    expect(parsed.text).toBe("Due Friday. Late submissions lose 10%.");
    expect(parsed.warnings).toEqual([]);
  });

  it("prefers the text/plain part of multipart/alternative and keeps the HTML", () => {
    const raw = [
      "From: a@b.com",
      "To: school@onesid.ca",
      "Subject: multipart",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="BOUND"',
      "",
      "--BOUND",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "plain body",
      "--BOUND",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>html body</p>",
      "--BOUND--",
      "",
    ].join("\r\n");
    const parsed = parseEmail(raw);
    expect(parsed.text).toBe("plain body");
    expect(parsed.html).toBe("<p>html body</p>");
    expect(parsed.warnings).toEqual([]);
  });

  it("decodes base64 and quoted-printable bodies", () => {
    const b64 = btoa("base64 secret body");
    const qpRaw = "Quoted=20printable=20body=\r\ncontinued here.";
    const raw = [
      "From: x@y.com",
      "Subject: s",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64,
    ].join("\r\n");
    expect(parseEmail(raw).text).toBe("base64 secret body");

    const raw2 = ["From: x@y.com", "Subject: s", "Content-Type: text/plain", "Content-Transfer-Encoding: quoted-printable", "", qpRaw].join("\r\n");
    expect(parseEmail(raw2).text).toBe("Quoted printable bodycontinued here.");
  });

  it("derives text from HTML when there is no text/plain — and says so", () => {
    const text = htmlToText("<p>Hello</p><script>evil()</script><p>World</p>");
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).not.toContain("evil()");

    const raw = [
      "From: x@y.com",
      "Subject: s",
      "Content-Type: text/html",
      "",
      "<p>Only html here</p>",
    ].join("\r\n");
    const parsed = parseEmail(raw);
    expect(parsed.text).toContain("Only html here");
    expect(parsed.warnings.some((w) => w.includes("derived from the HTML"))).toBe(true);
  });

  it("decodes RFC 2047 encoded subject words", () => {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode("Réunion")));
    const raw = ["From: x@y.com", `Subject: =?UTF-8?B?${b64}?=`, "Content-Type: text/plain", "", "body"].join("\r\n");
    expect(parseEmail(raw).subject).toBe("Réunion");
  });
});

// ---------------------------------------------------------------------------
// Inbound flow: archive + store + honest warnings
// ---------------------------------------------------------------------------

describe("email: inbound flow", () => {
  it("archives the raw .eml, stores the parsed row, and reports no warnings when all is well", async () => {
    const clock = new FixedClock();
    const bucket = new InMemoryBucket();
    const repo = new InMemoryEmailsRepo();
    const accepted = await acceptInboundEmail(
      { emails: repo, bucket, clock },
      { raw: "From: t@limestone.on.ca\r\nSubject: hi\r\nContent-Type: text/plain\r\n\r\nhello", envelopeFrom: "t@limestone.on.ca", envelopeTo: "school@onesid.ca" },
    );
    expect(accepted.warnings).toEqual([]);
    expect(accepted.r2Key).toMatch(/^emails\/\d{4}-\d{2}-\d{2}\/.+\.eml$/);
    const stored = await repo.get(accepted.email.id);
    expect(stored!.subject).toBe("hi");
    expect(stored!.reviewedAt).toBeNull();
    expect(await bucket.get(accepted.r2Key!)).toContain("hello");
  });

  it("stores the parsed record even when the archive bucket fails, and says so", async () => {
    const clock = new FixedClock();
    const repo = new InMemoryEmailsRepo();
    const brokenBucket = { put: async () => { throw new Error("R2 down"); }, get: async () => undefined };
    const accepted = await acceptInboundEmail(
      { emails: repo, bucket: brokenBucket as never, clock },
      { raw: "From: a@b.c\r\nSubject: s\r\n\r\nbody", envelopeFrom: "a@b.c", envelopeTo: "school@onesid.ca" },
    );
    expect(accepted.r2Key).toBeNull();
    expect(accepted.warnings.some((w) => w.includes("R2 failed"))).toBe(true);
    expect(await repo.get(accepted.email.id)).toBeTruthy();
  });

  it("the wake text carries sender/subject/body and reports exactly how much a cap dropped", async () => {
    const repo = new InMemoryEmailsRepo();
    const clock = new FixedClock();
    const accepted = await acceptInboundEmail(
      { emails: repo, bucket: undefined, clock },
      { raw: "From: a@b.c\r\nSubject: long\r\nContent-Type: text/plain\r\n\r\n" + "x".repeat(EMAIL_EXCERPT_CAP + 500), envelopeFrom: "a@b.c", envelopeTo: "school@onesid.ca" },
    );
    const text = wakeTextFor(accepted.email);
    expect(text).toContain("From: a@b.c");
    expect(text).toContain("Subject: long");
    expect(text).toContain(`first ${EMAIL_EXCERPT_CAP} of ${EMAIL_EXCERPT_CAP + 500} characters; 500 not shown`);
    expect(text).toContain("email_read");
  });
});

// ---------------------------------------------------------------------------
// Worker email() handler — real D1, fake queue / no queue
// ---------------------------------------------------------------------------

function emailMessage(raw: string, from = "t@limestone.on.ca", to = "school@onesid.ca") {
  const rejects: string[] = [];
  return {
    msg: { raw: new Response(raw).body!, from, to, setReject: (r: string) => rejects.push(r) },
    rejects,
  };
}

const ctxStub = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) };

describe("email: Cloudflare Email Worker handler", () => {
  it("stores the email in D1 and enqueues the wake when WORK_QUEUE is bound", async () => {
    const db = freshDb();
    const sent: unknown[] = [];
    const env = { DB: db, WORK_QUEUE: { send: async (m: unknown) => sent.push(m) } } as unknown as Env;
    const { msg } = emailMessage("From: t@limestone.on.ca\r\nSubject: quiz\r\nContent-Type: text/plain\r\n\r\nquiz posted");
    await worker.email(msg as never, env, ctxStub);
    const rows = await new D1EmailsRepo(db).recent();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe("quiz");
    expect(sent).toEqual([{ kind: "email", emailId: rows[0]!.id }]);
  });

  it("without D1 the mail is REJECTED (a bounce), never silently dropped", async () => {
    const env = {} as Env;
    const { msg, rejects } = emailMessage("From: a@b.c\r\nSubject: s\r\n\r\nx");
    await worker.email(msg as never, env, ctxStub);
    expect(rejects.length).toBe(1);
    expect(rejects[0]).toContain("could not be stored");
  });

  it("a wake failure is logged, not thrown — the stored row survives", async () => {
    const db = freshDb();
    const env = { DB: db } as unknown as Env; // no queue, no JARVIS => wake fails
    const { msg, rejects } = emailMessage("From: a@b.c\r\nSubject: s\r\n\r\nx");
    await expect(worker.email(msg as never, env, ctxStub)).resolves.toBeUndefined();
    expect(rejects).toHaveLength(0); // storing worked; only the wake failed
    expect(await new D1EmailsRepo(db).recent()).toHaveLength(1);
  });
});

describe("email: queue consumer", () => {
  function batchOf(messages: { id: string; body: unknown; attempts: number }[]) {
    const acked: string[] = [];
    const retried: { id: string; attempts: number }[] = [];
    return {
      batch: {
        messages: messages.map((m) => ({
          ...m,
          ack: () => acked.push(m.id),
          retry: () => retried.push({ id: m.id, attempts: m.attempts }),
        })),
      },
      acked,
      retried,
    };
  }

  it("acks unknown job kinds loudly (no silent drop)", async () => {
    const { batch, acked, retried } = batchOf([{ id: "m1", body: { kind: "???" }, attempts: 1 }]);
    await worker.queue(batch as never, {} as Env);
    expect(acked).toEqual(["m1"]);
    expect(retried).toEqual([]);
  });

  it("retries a failing email wake, then gives up loudly", async () => {
    const { batch, acked, retried } = batchOf([{ id: "m1", body: { kind: "email", emailId: "e1" }, attempts: 1 }]);
    await worker.queue(batch as never, {} as Env); // no JARVIS => throws
    expect(retried).toHaveLength(1);
    expect(acked).toEqual([]);

    const { batch: last, acked: ackedLast } = batchOf([{ id: "m2", body: { kind: "email", emailId: "e1" }, attempts: 5 }]);
    await worker.queue(last as never, {} as Env);
    expect(ackedLast).toEqual(["m2"]); // past the attempt cap: give up, logged
  });
});

// ---------------------------------------------------------------------------
// Outbound: Gmail + Microsoft Graph against a fake fetch
// ---------------------------------------------------------------------------

const cfg: EmailOutConfig = {
  personal: { provider: "gmail", fromAddress: "ksid1229@gmail.com", clientId: "ci", clientSecret: "cs", refreshToken: "rt" },
  school: { provider: "graph", fromAddress: "sk7qq09@limestone.on.ca", clientId: "ci2", clientSecret: "cs2", refreshToken: "rt2", tenantId: "ten" },
};

function fakeFetch(script: { match: (url: string) => boolean; status: number; body: string }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const hit = script.find((s) => s.match(url));
    return new Response(hit?.body ?? "{}", { status: hit?.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("email: outbound sender", () => {
  it("personal sends via Gmail: refresh token, then raw MIME send", async () => {
    const { calls, impl } = fakeFetch([
      { match: (u) => u.includes("oauth2.googleapis.com"), status: 200, body: JSON.stringify({ access_token: "AT" }) },
      { match: (u) => u.includes("gmail.googleapis.com"), status: 200, body: JSON.stringify({ id: "m1" }) },
    ]);
    const sender = new EmailSender(cfg, impl);
    const res = await sender.send("personal", { to: "someone@example.com", subject: "Hi", body: "Body" });
    expect(res.ok).toBe(true);
    expect(res.status).toBe("sent");
    expect(res.fromAddress).toBe("ksid1229@gmail.com");
    const tokenCall = calls.find((c) => c.url.includes("oauth2.googleapis.com"))!;
    expect(String(tokenCall.init.body)).toContain("grant_type=refresh_token");
    const sendCall = calls.find((c) => c.url.includes("gmail.googleapis.com"))!;
    expect((sendCall.init.headers as Record<string, string>).authorization).toBe("Bearer AT");
    const raw = JSON.parse(String(sendCall.init.body)) as { raw: string };
    const mime = atob(raw.raw.replace(/-/g, "+").replace(/_/g, "/"));
    expect(mime).toContain("From: ksid1229@gmail.com");
    expect(mime).toContain("To: someone@example.com");
    expect(mime).toContain("Subject: Hi");
  });

  it("school sends via Microsoft Graph sendMail from the school address", async () => {
    const { calls, impl } = fakeFetch([
      { match: (u) => u.includes("login.microsoftonline.com"), status: 200, body: JSON.stringify({ access_token: "GT" }) },
      { match: (u) => u.includes("graph.microsoft.com"), status: 200, body: "" },
    ]);
    const sender = new EmailSender(cfg, impl);
    const res = await sender.send("school", { to: "teacher@limestone.on.ca", subject: "Late", body: "Sorry" });
    expect(res.ok).toBe(true);
    const tokenCall = calls.find((c) => c.url.includes("login.microsoftonline.com"))!;
    expect(tokenCall.url).toContain("ten"); // tenant from config
    const sendCall = calls.find((c) => c.url.includes("graph.microsoft.com"))!;
    expect(sendCall.url).toContain(encodeURIComponent("sk7qq09@limestone.on.ca"));
    const body = JSON.parse(String(sendCall.init.body)) as { message: { toRecipients: { emailAddress: { address: string } }[] } };
    expect(body.message.toRecipients[0]!.emailAddress.address).toBe("teacher@limestone.on.ca");
  });

  it("provider failures are surfaced with the provider's own error text, never 'sent'", async () => {
    const { impl } = fakeFetch([
      { match: (u) => u.includes("oauth2.googleapis.com"), status: 200, body: JSON.stringify({ access_token: "AT" }) },
      { match: (u) => u.includes("gmail.googleapis.com"), status: 403, body: JSON.stringify({ error: { message: "Authentication failed. Credentials expired." } }) },
    ]);
    const sender = new EmailSender(cfg, impl);
    const res = await sender.send("personal", { to: "a@b.c", subject: "s", body: "b" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("gmail_403");
    expect(res.detail).toContain("Credentials expired");
  });

  it("fail closed per account: unconfigured secrets => not_connected naming the gaps", async () => {
    const sender = new EmailSender(
      { personal: { provider: "gmail", fromAddress: "k@g.com", clientId: "ci", clientSecret: undefined, refreshToken: "rt" } },
      (async () => new Response("{}")) as unknown as typeof fetch,
    );
    expect(sender.missing("personal")).toContain("CLIENT_SECRET");
    const res = await sender.send("personal", { to: "a@b.c", subject: "s", body: "b" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("not_connected");
    expect(res.detail).toContain("CLIENT_SECRET");
    expect((await sender.send("school", { to: "a@b.c", subject: "s", body: "b" })).status).toBe("not_connected");
  });

  it("refuses a bad address or empty subject/body before any network call", async () => {
    const { calls, impl } = fakeFetch([]);
    const sender = new EmailSender(cfg, impl);
    expect((await sender.send("personal", { to: "not-an-email", subject: "s", body: "b" })).status).toBe("refused");
    expect((await sender.send("personal", { to: "a@b.c", subject: " ", body: "b" })).status).toBe("refused");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DO email wake: the brain really sees the email and marks it reviewed
// ---------------------------------------------------------------------------

describe("email: DO wake handler (end to end with a scripted DeepSeek)", () => {
  it("wakes the one brain with the email text; marks reviewed; no model => honest error", async () => {
    const db = freshDb();
    const repo = new D1EmailsRepo(db);
    const stored = await repo.insert({
      fromAddr: "teacher@limestone.on.ca",
      toAddr: "school@onesid.ca",
      subject: "Quiz 3 moved",
      textBody: "Quiz 3 is now on Tuesday.",
      receivedAt: "2026-09-27T12:00:00.000Z",
      r2Key: null,
    });

    // Script DeepSeek: capture what the brain was asked, reply plainly.
    const seen: { messages: { role: string; content: string }[] }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { messages: { role: string; content: string }[] };
      seen.push(body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Noted, quiz moved to Tuesday." } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env = { DB: db, DEEPSEEK_API_KEY: "k", OWNER_CHAT_ID: "sid", OWNER_TIMEZONE: "America/Toronto" } as unknown as Env;
      const dobj = new JarvisDurableObject({} as never, env);
      const res = await (dobj as unknown as { handleEmailWake(r: Request): Promise<Response> }).handleEmailWake(
        new Request("https://do/email", { method: "POST", body: JSON.stringify({ emailId: stored.id }) }),
      );
      expect(res.status).toBe(200);
      const userMsg = seen.at(-1)!.messages.find((m) => m.role === "user")!;
      expect(userMsg.content).toContain("teacher@limestone.on.ca");
      expect(userMsg.content).toContain("Quiz 3 moved");
      expect(userMsg.content).toContain("Quiz 3 is now on Tuesday.");
      expect((await repo.get(stored.id))!.reviewedAt).not.toBeNull();

      // No model configured: honest, no fake answer, email stays unreviewed.
      const stored2 = await repo.insert({
        fromAddr: "a@b.c", toAddr: "school@onesid.ca", subject: "s2", textBody: "b2",
        receivedAt: "2026-09-27T13:00:00.000Z", r2Key: null,
      });
      const dobj2 = new JarvisDurableObject({} as never, { DB: freshDb(), OWNER_CHAT_ID: "sid" } as unknown as Env);
      const repo2 = new D1EmailsRepo((dobj2 as unknown as { env: Env }).env.DB as never);
      void repo2;
      const envNoModel = { DB: db, OWNER_CHAT_ID: "sid" } as unknown as Env;
      const dobj3 = new JarvisDurableObject({} as never, envNoModel);
      const res2 = await (dobj3 as unknown as { handleEmailWake(r: Request): Promise<Response> }).handleEmailWake(
        new Request("https://do/email", { method: "POST", body: JSON.stringify({ emailId: stored2.id }) }),
      );
      expect(await res2.json()).toMatchObject({ ok: false, reason: "no model key" });
      expect((await repo.get(stored2.id))!.reviewedAt).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// email tools
// ---------------------------------------------------------------------------

describe("email: email_list / email_read tools", () => {
  it("lists newest first with previews, reads one in full, and filters by since", async () => {
    const h = makeHarness([{ content: "x" }]);
    const repo = h.emails;
    const e1 = await repo.insert({ fromAddr: "a@b.c", toAddr: "school@onesid.ca", subject: "first", textBody: "one\nsecond line", receivedAt: "2026-09-26T10:00:00.000Z", r2Key: null });
    const e2 = await repo.insert({ fromAddr: "d@e.f", toAddr: "school@onesid.ca", subject: "second", textBody: "two", receivedAt: "2026-09-27T10:00:00.000Z", r2Key: null });

    const list = await h.dispatcher.dispatch("email_list", {}, h.ctxFor(ownerEvent("any emails?", "e1")));
    expect(list.ok).toBe(true);
    const data = list.data as { id: string; subject: string }[];
    expect(data.map((d) => d.subject)).toEqual(["second", "first"]);

    const since = await h.dispatcher.dispatch("email_list", { since: "2026-09-27T00:00:00Z" }, h.ctxFor(ownerEvent("e", "e1")));
    expect((since.data as { subject: string }[]).map((d) => d.subject)).toEqual(["second"]);

    const bad = await h.dispatcher.dispatch("email_list", { since: "yesterday" }, h.ctxFor(ownerEvent("e", "e1")));
    expect(bad.status).toBe("refused");

    const read = await h.dispatcher.dispatch("email_read", { email_id: e1.id }, h.ctxFor(ownerEvent("e", "e1")));
    expect(read.ok).toBe(true);
    expect(read.message).toContain("one\nsecond line");
    expect((await h.dispatcher.dispatch("email_read", { email_id: "nope" }, h.ctxFor(ownerEvent("e", "e1")))).status).toBe("not_found");

    void e2;
  });
});
