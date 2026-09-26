import type { Clock } from "../clock.js";
import type { Bucket } from "./bucket.js";

/**
 * Nightly backup: export EVERY table to a dated JSON object in R2. D1 Time Travel
 * is the second layer (a deploy-side setting, not code). The first build's vault
 * export stopped at 64 items; this processes ALL rows and REPORTS the count per
 * table so a silent truncation would be visible.
 */
export class BackupService {
  constructor(
    private readonly bucket: Bucket,
    private readonly clock: Clock,
    /** table name -> a function returning all its rows. */
    private readonly sources: Record<string, () => unknown[]>,
  ) {}

  async exportAll(): Promise<{ key: string; counts: Record<string, number> }> {
    const now = this.clock.nowIso();
    const dump: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    for (const [table, read] of Object.entries(this.sources)) {
      const rows = read();
      dump[table] = rows;
      counts[table] = rows.length;
    }
    const key = `backups/${now.slice(0, 10)}/${now}.json`;
    await this.bucket.put(key, JSON.stringify({ at: now, counts, tables: dump }));
    return { key, counts };
  }
}
