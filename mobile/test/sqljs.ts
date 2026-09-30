// Db over sql.js for tests under Node: same SQLite engine, in memory (or loaded from a file).
import initSqlJs, { type Database } from "sql.js";
import type { Db, Params, Row } from "../src/db/types";

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

export async function openTestDb(bytes?: Uint8Array): Promise<Db & { raw: Database }> {
  SQL ??= await initSqlJs();
  const raw = new SQL.Database(bytes);
  raw.run("PRAGMA foreign_keys = ON;");
  let depth = 0;
  const db = {
    raw,
    async all(sql: string, params: Params = []): Promise<Row[]> {
      const stmt = raw.prepare(sql);
      stmt.bind(params as any[]);
      const rows: Row[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    async run(sql: string, params: Params = []) {
      raw.run(sql, params as any[]);
      const lastId = raw.exec("SELECT last_insert_rowid()")[0].values[0][0] as number;
      return { changes: raw.getRowsModified(), lastId };
    },
    async exec(sql: string) {
      raw.exec(sql);
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (depth > 0) return fn();
      raw.run("BEGIN");
      depth = 1;
      try {
        const result = await fn();
        raw.run("COMMIT");
        return result;
      } catch (e) {
        raw.run("ROLLBACK");
        throw e;
      } finally {
        depth = 0;
      }
    },
  };
  return db;
}
