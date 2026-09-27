import { loadConfig, type PcAgentConfig } from "./config.js";
import { postResult, pullJobs, sendHeartbeat, type PulledJob } from "./http.js";
import { runShellCommand, type ShellResult } from "./jobs/shell.js";
import { openUrl } from "./jobs/open-url.js";
import { runBrowserTask, type BrowserContext, type BrowserModule } from "./jobs/browser.js";

/** Dynamic import through a variable so the playwright dep can be absent at type-check time. */
async function importModule(name: string): Promise<BrowserModule> {
  return (await import(/* @vite-ignore */ name)) as unknown as BrowserModule;
}

/**
 * The daemon: every poll interval, tell Jarvis this PC is alive, pull queued
 * jobs, run them one at a time, and post each result. Honest by construction:
 *  - a job that cannot run (unknown kind, missing config) FAILS loudly — it is
 *    never skipped silently, and its failure is posted back so the brain knows;
 *  - an unreachable Jarvis is logged and retried next tick, never swallowed;
 *  - Ctrl+C stops it cleanly.
 */

export type JobResult = { ok: boolean; result?: unknown; error?: string };

/** The HTTP slice, injectable for tests. */
export interface HttpDeps {
  pull(cfg: PcAgentConfig): Promise<{ jobs: PulledJob[] }>;
  heartbeat(cfg: PcAgentConfig): Promise<unknown>;
  postResult(cfg: PcAgentConfig, jobId: string, result: JobResult): Promise<unknown>;
}

export interface AgentDeps {
  http?: HttpDeps;
  runShell?: typeof runShellCommand;
  open?: typeof openUrl;
  runBrowser?: typeof runBrowserTask;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export class PcAgent {
  private stopped = false;
  private sharedBrowserContext: BrowserContext | undefined;
  private readonly browserDeps: { importPlaywright(): Promise<BrowserModule>; chromeProfileDir: string | undefined };

  constructor(
    private readonly cfg: PcAgentConfig,
    private readonly deps: AgentDeps = {},
  ) {
    this.browserDeps = {
      importPlaywright: () => importModule("playwright"),
      chromeProfileDir: cfg.chromeProfileDir,
    };
  }

  /** One tick: heartbeat, pull, execute, report. Returns how many jobs ran. */
  async tick(): Promise<number> {
    const http = this.deps.http ?? { pull: pullJobs, heartbeat: sendHeartbeat, postResult };
    try {
      await http.heartbeat(this.cfg);
    } catch (e) {
      this.log(`heartbeat failed: ${(e as Error).message}`);
    }
    let jobs: PulledJob[];
    try {
      jobs = (await http.pull(this.cfg)).jobs ?? [];
    } catch (e) {
      this.log(`pull failed: ${(e as Error).message}`);
      return 0;
    }
    for (const job of jobs) {
      const outcome = await this.execute(job);
      try {
        await http.postResult(this.cfg, job.id, outcome);
        this.log(`job ${job.id} (${job.kind}) → ${outcome.ok ? "ok" : `failed: ${outcome.error ?? ""}`}`);
      } catch (e) {
        // The job RAN; only the report failed. Say so loudly — the brain will
        // still show the job as delivered until a retry, never as done.
        this.log(`job ${job.id} ran but posting its result failed: ${(e as Error).message}`);
      }
    }
    return jobs.length;
  }

  async execute(job: PulledJob): Promise<JobResult> {
    try {
      switch (job.kind) {
        case "shell": {
          const command = typeof job.args.command === "string" ? job.args.command : "";
          if (command === "") return { ok: false, error: "shell job had no command" };
          const timeoutMs = typeof job.args.timeout_seconds === "number" ? job.args.timeout_seconds * 1000 : undefined;
          const shell = await (this.deps.runShell ?? runShellCommand)(command, timeoutMs ? { timeoutMs } : {});
          return { ok: shell.ok, result: shell, ...(shell.ok ? {} : { error: summarize(shell) }) };
        }
        case "open_url": {
          const url = typeof job.args.url === "string" ? job.args.url : "";
          if (url === "") return { ok: false, error: "open_url job had no url" };
          const r = await (this.deps.open ?? openUrl)(url);
          return { ok: r.ok, ...(r.ok ? { result: { opened: url, detail: r.detail } } : { error: r.detail }) };
        }
        case "browser": {
          const r = await (this.deps.runBrowser ?? runBrowserTask)(job.args, {
            ...this.browserDeps,
            ...(this.sharedBrowserContext ? { sharedContext: { get: () => this.sharedBrowserContext } } : {}),
          });
          return { ok: r.ok, result: r, ...(r.ok ? {} : { error: r.note }) };
        }
        default:
          return { ok: false, error: `unknown job kind: ${(job as { kind?: string }).kind}` };
      }
    } catch (e) {
      return { ok: false, error: `job threw: ${(e as Error).message}` };
    }
  }

  async run(): Promise<void> {
    this.log(`Jarvis PC agent ${this.cfg.version} — polling ${this.cfg.jarvisUrl} every ${Math.round(this.cfg.pollMs / 1000)}s`);
    while (!this.stopped) {
      const ran = await this.tick();
      if (ran === 0) await (this.deps.sleep ?? sleep)(this.cfg.pollMs);
      else await (this.deps.sleep ?? sleep)(250); // more work may be waiting
    }
    this.log("stopped");
  }

  stop(): void {
    this.stopped = true;
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(`[${new Date().toISOString()}] ${l}`)))(line);
  }
}

function summarize(shell: ShellResult): string {
  if (shell.timedOut) return `command timed out after ${shell.exitCode === null ? "" : ""}${shell.program}`;
  return `exit ${shell.exitCode}: ${shell.stderr.slice(0, 200)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Entry point (node dist/agent.js). Registration for automatic start-up is
// scripts/install-task.ps1 (Task Scheduler, at logon).
if (process.argv[1]?.endsWith("agent.js") === true) {
  try {
    const agent = new PcAgent(loadConfig());
    const stop = () => agent.stop();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    void agent.run();
  } catch (e) {
    console.error(`Cannot start the PC agent: ${(e as Error).message}`);
    process.exit(1);
  }
}
