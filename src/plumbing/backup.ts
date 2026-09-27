import type { Clock } from "../clock.js";
import type { Bucket } from "./bucket.js";
import type { D1Db, D1Row } from "../persistence/d1.js";

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
    private readonly sources: Record<string, () => Promise<unknown[]>>,
    /** When set, the table list is discovered at backup time (D1). */
    private readonly discover?: () => Promise<Record<string, () => Promise<unknown[]>>>,
  ) {}

  /**
   * Back up EVERY table in the D1 database: the table list is read from
   * sqlite_master at backup time, so a table added by a later migration is
   * included automatically. Rows are exported raw (column names as in the
   * migrations), so the backup restores without any code.
   */
  static fromD1(bucket: Bucket, clock: Clock, db: D1Db): BackupService {
    return new BackupService(bucket, clock, {}, async () => {
      const tables = await db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'
           ORDER BY name`,
        )
        .all<D1Row>();
      const sources: Record<string, () => Promise<unknown[]>> = {};
      for (const t of tables.results) {
        const name = String(t.name);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`backup: unexpected table name ${name}`);
        sources[name] = async () => (await db.prepare(`SELECT * FROM "${name}"`).all<D1Row>()).results;
      }
      return sources;
    });
  }

  async exportAll(): Promise<{ key: string; counts: Record<string, number> }> {
    const now = this.clock.nowIso();
    const dump: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    const sources = this.discover ? await this.discover() : this.sources;
    for (const [table, read] of Object.entries(sources)) {
      const rows = await read();
      dump[table] = rows;
      counts[table] = rows.length;
    }
    const key = `backups/${now.slice(0, 10)}/${now}.json`;
    await this.bucket.put(key, JSON.stringify({ at: now, counts, tables: dump }));
    return { key, counts };
  }
}
