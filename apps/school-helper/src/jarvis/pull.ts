/**
 * Pull channel executor: asks Jarvis what it wants, then does it.
 *
 * The extension can only be reached this way — MV3 service workers cannot hold
 * a push socket — so Jarvis queues sync_now/open_item requests and the
 * background alarm collects them while Sid's browser is open. Every side
 * effect is injected, so tests run without chrome.
 */
import type { JarvisTransport } from './transport';

export interface PullDeps {
  transport: () => Promise<JarvisTransport>;
  /** False (or throwing) means unpaired/disabled: pull nothing, fail nothing. */
  isLinked: () => Promise<boolean>;
  /** Full sync + evidence push, owned by the background worker. */
  runSync: () => Promise<unknown>;
  openUrl: (url: string) => Promise<void>;
  /** Origins open_item may open. Anything else is skipped, never opened. */
  allowedOrigins: string[];
  log: (entry: { endpoint: string; ok: boolean; detail?: string }) => Promise<void>;
}

export interface PullOutcome {
  pulled: number;
  ran: string[];
  skipped: string[];
  error: string | null;
}

export async function pullAndExecute(deps: PullDeps): Promise<PullOutcome> {
  const outcome: PullOutcome = { pulled: 0, ran: [], skipped: [], error: null };
  let linked = false;
  try {
    linked = await deps.isLinked();
  } catch {
    return outcome;
  }
  if (!linked) return outcome;

  let requests: { requestId: string; action: string; args: unknown }[];
  try {
    const transport = await deps.transport();
    requests = await transport.pullRequests();
  } catch (error) {
    outcome.error = (error as Error).message;
    return outcome;
  }
  outcome.pulled = requests.length;

  for (const req of requests) {
    try {
      if (req.action === 'sync_now') {
        await deps.runSync();
        outcome.ran.push(req.requestId);
      } else if (req.action === 'open_item') {
        const url = (req.args as Record<string, unknown> | null)?.itemUrl;
        if (typeof url !== 'string' || !deps.allowedOrigins.some((o) => url.startsWith(o))) {
          outcome.skipped.push(req.requestId);
        } else {
          await deps.openUrl(url);
          outcome.ran.push(req.requestId);
        }
      } else {
        outcome.skipped.push(req.requestId);
      }
    } catch (error) {
      outcome.skipped.push(req.requestId);
      await deps
        .log({
          endpoint: '/school/pull',
          ok: false,
          detail: `${req.requestId}:${(error as Error).message}`,
        })
        .catch(() => undefined);
    }
  }
  if (requests.length > 0) {
    await deps
      .log({
        endpoint: '/school/pull',
        ok: true,
        detail: `ran ${outcome.ran.length}, skipped ${outcome.skipped.length}`,
      })
      .catch(() => undefined);
  }
  return outcome;
}
