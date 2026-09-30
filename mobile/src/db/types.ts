// The small database interface all app logic is written against. Two implementations:
// the Capacitor SQLite plugin (phone and browser; src/db/capacitor.ts) and sql.js under
// Node for tests (test/sqljs.ts). Keep it this small so both stay trivially correct.

export type Row = Record<string, any>;
export type Params = unknown[];

export interface Db {
  /** Rows of a SELECT (or any statement returning rows). */
  all(sql: string, params?: Params): Promise<Row[]>;
  /** One INSERT/UPDATE/DELETE. lastId is the new rowid after an INSERT. */
  run(sql: string, params?: Params): Promise<{ changes: number; lastId: number }>;
  /** Several ;-separated statements without parameters (schema changes). */
  exec(sql: string): Promise<void>;
  /**
   * Runs fn inside one transaction: all of its writes happen or none do. Nested calls join
   * the outer transaction. In the browser the database is saved to storage after commit.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/** First row, or undefined. */
export async function get(db: Db, sql: string, params?: Params): Promise<Row | undefined> {
  return (await db.all(sql, params))[0];
}

/** Current UTC time in the stored format, e.g. "2026-09-30 18:00:00.000000" (matches the Flask data). */
export function utcNow(date = new Date()): string {
  return date.toISOString().replace("T", " ").replace("Z", "000");
}
