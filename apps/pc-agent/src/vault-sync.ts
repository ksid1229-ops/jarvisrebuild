import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { fetchVaultExport, type VaultExport } from "./http.js";

/**
 * One-way vault sync: Jarvis is the source of truth. This pulls /vault/export
 * and writes every note as markdown-with-frontmatter into Sid's Obsidian vault.
 *
 * Hard rules, from the first build's failures:
 *  - EVERY note is processed. The old build stopped at 64; here a mismatch
 *    between the server's count and what we processed is a hard error.
 *  - Idempotent: identical content is skipped (counted), so hourly runs only
 *    write what changed.
 *  - Files are only ever written under the vault's jarvis/ folder. A path
 *    trying to escape (.., absolute, drive letters) is rejected loudly.
 *  - Nothing is deleted: Obsidian notes Sid may have linked to stay.
 */

export interface SyncReport {
  count: number;
  written: number;
  skippedUnchanged: number;
  rejectedPaths: string[];
}

export function safeVaultPath(vaultDir: string, notePath: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(notePath)) return null;
  if (notePath.includes("..") || notePath.startsWith("/") || /^[A-Za-z]:/.test(notePath) || notePath.includes("\\")) return null;
  const full = resolve(join(vaultDir, notePath));
  if (!full.startsWith(resolve(vaultDir))) return null;
  return full;
}

export type FetchVaultExport = (cfg: { jarvisUrl: string; pcAgentToken: string }, vaultToken: string) => Promise<VaultExport>;

export async function syncVault(
  cfg: { jarvisUrl: string; pcAgentToken: string; vaultToken: string; vaultDir: string },
  deps: { fetchExport?: FetchVaultExport; io?: { mkdir: typeof mkdir; readFile: typeof readFile; writeFile: typeof writeFile } } = {},
): Promise<SyncReport> {
  const io = deps.io ?? { mkdir, readFile, writeFile };
  const fetchExport = deps.fetchExport ?? ((c: { jarvisUrl: string; pcAgentToken: string }, token: string) => fetchVaultExport(c as Parameters<typeof fetchVaultExport>[0], token));
  const exported = await fetchExport(cfg, cfg.vaultToken);
  if (!exported.ok || typeof exported.count !== "number" || !Array.isArray(exported.notes)) {
    throw new Error(`vault export did not return a valid payload: ${JSON.stringify(exported).slice(0, 200)}`);
  }

  const report: SyncReport = { count: exported.count, written: 0, skippedUnchanged: 0, rejectedPaths: [] };
  for (const note of exported.notes) {
    const full = safeVaultPath(cfg.vaultDir, note.path);
    if (full === null) {
      report.rejectedPaths.push(note.path);
      continue;
    }
    let existing: string | null = null;
    try {
      existing = await io.readFile(full, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (existing === note.markdown) {
      report.skippedUnchanged++;
      continue;
    }
    await io.mkdir(dirname(full), { recursive: true });
    await io.writeFile(full, note.markdown, "utf8");
    report.written++;
  }

  const processed = report.written + report.skippedUnchanged + report.rejectedPaths.length;
  if (processed !== exported.count) {
    throw new Error(`vault sync processed ${processed} of ${exported.count} notes — refusing to call that a success.`);
  }
  return report;
}

// Entry point (node dist/vault-sync.js). install-task.ps1 schedules this hourly.
if (process.argv[1]?.endsWith("vault-sync.js") === true) {
  try {
    const cfg = loadConfig();
    if (!cfg.vaultToken || !cfg.vaultDir) {
      console.error("vault-sync needs VAULT_TOKEN and VAULT_DIR (config.json or env vars). Nothing was synced.");
      process.exit(1);
    }
    const report = await syncVault({ jarvisUrl: cfg.jarvisUrl, pcAgentToken: cfg.pcAgentToken, vaultToken: cfg.vaultToken, vaultDir: cfg.vaultDir });
    console.log(
      `Vault sync: ${report.written} written, ${report.skippedUnchanged} unchanged, ${report.count} total` +
        (report.rejectedPaths.length > 0 ? `, REJECTED PATHS: ${report.rejectedPaths.join(", ")}` : ""),
    );
  } catch (e) {
    console.error(`Vault sync failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
