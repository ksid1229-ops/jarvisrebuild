import { describe, expect, it } from "vitest";
import { PcAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import type { HttpDeps } from "../src/agent.js";

const cfg = () => loadConfig({ jarvisUrl: "https://jarvis.example", pcAgentToken: "tok", pollMs: 10_000 });

function recordingHttp(jobs: Parameters<HttpDeps["pull"]>[0] extends never ? never : { id: string; kind: "shell" | "open_url" | "browser"; args: Record<string, unknown> }[]) {
  const heartbeats: number[] = [];
  const posted: { jobId: string; ok: boolean; error?: string; result?: unknown }[] = [];
  const http: HttpDeps = {
    heartbeat: async () => {
      heartbeats.push(1);
      return {};
    },
    pull: async () => ({ jobs: jobs.splice(0) }),
    postResult: async (_c, jobId, result) => {
      posted.push({ jobId, ...result });
      return {};
    },
  };
  return { http, heartbeats, posted };
}

describe("pc agent loop", () => {
  it("a tick heartbeats, runs each job, and posts every result", async () => {
    const rec = recordingHttp([
      { id: "j1", kind: "shell", args: { command: "echo hi" } },
      { id: "j2", kind: "open_url", args: { url: "https://x.example" } },
    ]);
    const logs: string[] = [];
    const agent = new PcAgent(cfg(), {
      http: rec.http,
      log: (l) => logs.push(l),
      runShell: async (cmd) => ({ ok: true, exitCode: 0, stdout: `ran ${cmd}`, stderr: "", timedOut: false, truncated: false, command: cmd, program: "sh" }),
      open: async (url) => ({ ok: true, detail: `opened ${url}` }),
    });
    const ran = await agent.tick();
    expect(ran).toBe(2);
    expect(rec.heartbeats).toHaveLength(1);
    expect(rec.posted.map((p) => p.jobId)).toEqual(["j1", "j2"]);
    expect(rec.posted[0]!.ok).toBe(true);
    expect(rec.posted[0]!.result).toMatchObject({ stdout: "ran echo hi" });
    expect(rec.posted[1]!.ok).toBe(true);
    expect(logs.some((l) => l.includes("j1") && l.includes("ok"))).toBe(true);
  });

  it("an unknown job kind FAILS loudly — never skipped, never 'ok'", async () => {
    const rec = recordingHttp([{ id: "j9", kind: "telepathy" as never, args: {} }]);
    const agent = new PcAgent(cfg(), { http: rec.http, log: () => {} });
    await agent.tick();
    expect(rec.posted[0]!.ok).toBe(false);
    expect(rec.posted[0]!.error).toContain("unknown job kind");
  });

  it("a job that throws is reported as failed, not dropped", async () => {
    const rec = recordingHttp([{ id: "j1", kind: "shell", args: { command: "boom" } }]);
    const agent = new PcAgent(cfg(), {
      http: rec.http,
      log: () => {},
      runShell: async () => {
        throw new Error("powershell exploded");
      },
    });
    await agent.tick();
    expect(rec.posted[0]!.ok).toBe(false);
    expect(rec.posted[0]!.error).toContain("powershell exploded");
  });

  it("a shell job without a command fails honestly (server contract break)", async () => {
    const rec = recordingHttp([{ id: "j1", kind: "shell", args: {} }]);
    const agent = new PcAgent(cfg(), { http: rec.http, log: () => {} });
    await agent.tick();
    expect(rec.posted[0]!.ok).toBe(false);
    expect(rec.posted[0]!.error).toContain("no command");
  });

  it("a failed pull (Jarvis unreachable) logs and keeps going — the next tick retries", async () => {
    let failing = true;
    const rec = recordingHttp([{ id: "j1", kind: "shell", args: { command: "x" } }]);
    const http: HttpDeps = {
      heartbeat: async () => ({}),
      pull: async () => {
        if (failing) throw new Error("HTTP 0 from Jarvis: network error: dns is down");
        return rec.http.pull({} as never);
      },
      postResult: rec.http.postResult,
    };
    const logs: string[] = [];
    const agent = new PcAgent(cfg(), { http, log: (l) => logs.push(l) });
    expect(await agent.tick()).toBe(0);
    expect(logs.some((l) => l.includes("pull failed") && l.includes("dns"))).toBe(true);
    failing = false;
    expect(await agent.tick()).toBe(1);
  });

  it("a result that fails to POST is logged as ran-but-unreported", async () => {
    const rec = recordingHttp([{ id: "j1", kind: "shell", args: { command: "x" } }]);
    const logs: string[] = [];
    const agent = new PcAgent(cfg(), {
      http: { ...rec.http, postResult: async () => { throw new Error("HTTP 500"); } },
      log: (l) => logs.push(l),
      runShell: async (cmd) => ({ ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, command: cmd, program: "sh" }),
    });
    await agent.tick();
    expect(logs.some((l) => l.includes("ran but posting its result failed"))).toBe(true);
  });
});
