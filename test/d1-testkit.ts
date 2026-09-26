/**
 * Real SQLite (sql.js) behind the D1Db interface, with THE migration files
 * applied — not a copy. Shared by the persistence and school suites.
 */
import { beforeAll } from "vitest";
import initSqlJs, { type Database, type SqlValue } from "sql.js";
import type { D1Bound, D1Db, D1Prepared, D1Row, D1RunResult } from "../src/persistence/d1.js";
import migration0001 from "../migrations/0001_init.sql?raw";
import migration0002 from "../migrations/0002_school_surface.sql?raw";

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => `node_modules/sql.js/dist/${f}` });
});

/** sql.js-backed D1Db: real SQLite semantics for prepare/bind/first/all/run. */
class SqlJsDb implements D1Db {
  constructor(private readonly db: Database) {}
  prepare(query: string): D1Prepared {
    const db = this.db;
    const select = (params: unknown[]): D1Row[] => {
      const stmt = db.prepare(query);
      try {
        if (params.length > 0) stmt.bind(params as SqlValue[]);
        const rows: D1Row[] = [];
        while (stmt.step()) rows.push({ ...(stmt.getAsObject() as D1Row) });
        return rows;
      } finally {
        stmt.free();
      }
    };
    const bound = (params: unknown[]): D1Bound => ({
      first: async <T,>(column?: string): Promise<T | null> => {
        const rows = select(params);
        const row = rows[0];
        if (!row) return null;
        if (column !== undefined) return (row[column] ?? null) as T;
        return row as unknown as T;
      },
      all: async <T,>(): Promise<{ results: T[] }> => ({ results: select(params) as unknown as T[] }),
      run: async (): Promise<D1RunResult> => {
        db.run(query, params as SqlValue[]);
        return { success: true, changes: db.getRowsModified() };
      },
    });
    return {
      bind: (...params: unknown[]) => bound(params),
      first: <T,>(column?: string) => bound([]).first<T>(column),
      all: <T,>() => bound([]).all<T>(),
      run: () => bound([]).run(),
    };
  }
}

export function freshDb(): D1Db {
  if (!SQL) throw new Error("sql.js not initialized");
  const db = new SQL.Database();
  db.exec(migration0001);
  db.exec(migration0002);
  return new SqlJsDb(db);
}
