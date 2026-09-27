import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * PC agent configuration. Sources, in order: explicit object (tests), a
 * config.json next to the app (written by scripts/install-task.ps1), then
 * environment variables. Whatever wins, the required values must be there or
 * we refuse to run — an agent without its token would only get 401s.
 */
export interface PcAgentConfig {
  /** The Jarvis Worker base URL, e.g. https://jarvis.example.workers.dev */
  jarvisUrl: string;
  /** Bearer token for /pc/* routes (PC_AGENT_TOKEN on the Worker). */
  pcAgentToken: string;
  /** Vault export token (VAULT_EXPORT_TOKEN on the Worker). vault-sync only. */
  vaultToken?: string;
  /** Sid's Obsidian vault directory. vault-sync only. */
  vaultDir?: string;
  /** Pull/heartbeat interval in milliseconds (default 30s). */
  pollMs: number;
  /** Chrome user-data dir whose profile holds the saved card (browser jobs). */
  chromeProfileDir?: string;
  /** Reported to the heartbeat so Jarvis knows which agent version runs. */
  version: string;
}

export class ConfigError extends Error {}

const DEFAULT_POLL_MS = 30_000;

export function loadConfig(explicit?: Partial<PcAgentConfig>): PcAgentConfig {
  const file = readConfigFile();
  const env = {
    jarvisUrl: process.env.JARVIS_URL,
    pcAgentToken: process.env.PC_AGENT_TOKEN,
    vaultToken: process.env.VAULT_TOKEN,
    vaultDir: process.env.VAULT_DIR,
    pollMs: process.env.POLL_MS,
    chromeProfileDir: process.env.CHROME_PROFILE_DIR,
  };

  const jarvisUrl = (explicit?.jarvisUrl ?? file?.jarvisUrl ?? env.jarvisUrl ?? "").trim().replace(/\/+$/, "");
  const pcAgentToken = explicit?.pcAgentToken ?? file?.pcAgentToken ?? env.pcAgentToken ?? "";
  const vaultToken = explicit?.vaultToken ?? file?.vaultToken ?? env.vaultToken;
  const vaultDir = explicit?.vaultDir ?? file?.vaultDir ?? env.vaultDir;
  const chromeProfileDir = explicit?.chromeProfileDir ?? file?.chromeProfileDir ?? env.chromeProfileDir;
  const pollRaw = explicit?.pollMs ?? file?.pollMs ?? env.pollMs;
  const pollMs = pollRaw === undefined || `${pollRaw}`.trim() === "" ? DEFAULT_POLL_MS : Number(pollRaw);

  if (jarvisUrl === "") throw new ConfigError("JARVIS_URL is not set. Put it in config.json (run scripts\\install-task.ps1) or set the env var.");
  if (!/^https?:\/\//i.test(jarvisUrl)) throw new ConfigError(`JARVIS_URL must start with http(s):// — got: ${jarvisUrl}`);
  if (!pcAgentToken || pcAgentToken.trim() === "") throw new ConfigError("PC_AGENT_TOKEN is not set. Put it in config.json or set the env var.");
  if (!Number.isFinite(pollMs) || pollMs < 5000) throw new ConfigError(`POLL_MS must be a number >= 5000 — got: ${pollRaw}`);

  return {
    jarvisUrl,
    pcAgentToken: pcAgentToken.trim(),
    ...(vaultToken?.trim() ? { vaultToken: vaultToken.trim() } : {}),
    ...(vaultDir?.trim() ? { vaultDir: vaultDir.trim() } : {}),
    pollMs,
    ...(chromeProfileDir?.trim() ? { chromeProfileDir: chromeProfileDir.trim() } : {}),
    version: explicit?.version ?? "0.1.0",
  };
}

/** config.json lives next to the compiled app: <app>/dist/../config.json. */
function readConfigFile(): Partial<PcAgentConfig> | undefined {
  for (const candidate of [resolve(process.cwd(), "config.json"), resolve(process.cwd(), "..", "config.json")]) {
    try {
      const raw = readFileSync(candidate, "utf8");
      return JSON.parse(raw) as Partial<PcAgentConfig>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ConfigError(`config.json at ${candidate} is not valid JSON: ${(e as Error).message}`);
      }
    }
  }
  return undefined;
}
