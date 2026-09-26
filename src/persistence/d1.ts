/**
 * The D1 surface Jarvis needs. Production passes the real D1Database binding
 * straight in — these types mirror its prepare/bind/first/all/run shape, so
 * there is no translation layer to drift. Tests run the same SQL against real
 * SQLite (see test/persistence.test.ts), executing the actual migration files.
 */

export interface D1RunResult {
  success: boolean;
  changes: number;
}

export interface D1Bound {
  first<T = D1Row>(column?: string): Promise<T | null>;
  all<T = D1Row>(): Promise<{ results: T[] }>;
  run(): Promise<D1RunResult>;
}

export interface D1Prepared {
  bind(...params: unknown[]): D1Bound;
  /** Real D1 allows first/all/run with no bind when there are no params. */
  first<T = D1Row>(column?: string): Promise<T | null>;
  all<T = D1Row>(): Promise<{ results: T[] }>;
  run(): Promise<D1RunResult>;
}

export interface D1Db {
  prepare(query: string): D1Prepared;
}

/** A raw row from D1: column names exactly as in migrations/*.sql. */
export type D1Row = Record<string, unknown>;

/** Strict cell readers. A mistyped column is a loud error, never a coercion. */
export function str(v: unknown, what = "column"): string {
  if (typeof v !== "string") throw new Error(`d1: expected string for ${what}`);
  return v;
}

export function num(v: unknown, what = "column"): number {
  if (typeof v !== "number") throw new Error(`d1: expected number for ${what}`);
  return v;
}

export function optStr(v: unknown, what = "column"): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`d1: expected string|null for ${what}`);
  return v;
}

/** Booleans are stored 0/1. Anything else is refused, not guessed. */
export function bool(v: unknown, what = "column"): boolean {
  if (v === 1) return true;
  if (v === 0) return false;
  throw new Error(`d1: expected 0/1 for ${what}`);
}
