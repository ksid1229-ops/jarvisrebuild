import type { PcAgentConfig } from "./config.js";

/**
 * HTTP to the Jarvis Worker. Every failure is thrown with the status and the
 * body's first line — the agent reports it as a failed job or a logged error,
 * never a silent success. The token rides the Authorization header.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status} from Jarvis: ${body.slice(0, 200)}`);
  }
}

async function request(cfg: PcAgentConfig, path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${cfg.jarvisUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${cfg.pcAgentToken}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    throw new HttpError(0, `network error: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new HttpError(res.status, text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

export interface PulledJob {
  id: string;
  kind: "shell" | "open_url" | "browser";
  args: Record<string, unknown>;
}

export function pullJobs(cfg: PcAgentConfig): Promise<{ jobs: PulledJob[] }> {
  return request(cfg, "/pc/pull", { method: "POST", body: "{}" }) as Promise<{ jobs: PulledJob[] }>;
}

export function sendHeartbeat(cfg: PcAgentConfig): Promise<unknown> {
  return request(cfg, "/pc/heartbeat", { method: "POST", body: JSON.stringify({ version: cfg.version }) });
}

export function postResult(
  cfg: PcAgentConfig,
  jobId: string,
  result: { ok: boolean; result?: unknown; error?: string },
): Promise<unknown> {
  return request(cfg, "/pc/result", { method: "POST", body: JSON.stringify({ jobId, ...result }) });
}

export interface VaultExport {
  ok: boolean;
  count: number;
  notes: { path: string; markdown: string }[];
  schoolUnreadable?: number;
}

export function fetchVaultExport(cfg: PcAgentConfig, vaultToken: string): Promise<VaultExport> {
  return request(cfg, "/vault/export", { headers: { "x-vault-token": vaultToken } }) as Promise<VaultExport>;
}
