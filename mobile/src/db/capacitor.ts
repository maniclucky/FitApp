// Db over the Capacitor SQLite plugin. On Android/iOS this is a native SQLite file; in a
// browser the same API runs sql.js (WebAssembly) and is saved to IndexedDB via the
// <jeep-sqlite> element, which only happens when we call saveToStore.
import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from "@capacitor-community/sqlite";
import { defineCustomElements as defineJeepSqlite } from "jeep-sqlite/loader";
import type { Db, Params, Row } from "./types";

const DB_NAME = "fitapp";
const sqlite = new SQLiteConnection(CapacitorSQLite);
const isWeb = Capacitor.getPlatform() === "web";

export async function openCapacitorDb(): Promise<Db> {
  if (isWeb) {
    defineJeepSqlite(window);
    const jeep = document.createElement("jeep-sqlite");
    // Its default "/assets" breaks when the app is served from a sub-folder (e.g. a Pages site).
    jeep.setAttribute("wasmpath", "./assets");
    document.body.appendChild(jeep);
    await customElements.whenDefined("jeep-sqlite");
    await sqlite.initWebStore();
  }
  const conn = await sqlite.createConnection(DB_NAME, false, "no-encryption", 1, false);
  await conn.open();
  await conn.execute("PRAGMA foreign_keys = ON;", false);
  return new CapacitorDb(conn);
}

class CapacitorDb implements Db {
  private depth = 0;
  constructor(private conn: SQLiteDBConnection) {}

  async all(sql: string, params: Params = []): Promise<Row[]> {
    return (await this.conn.query(sql, params)).values ?? [];
  }

  async run(sql: string, params: Params = []) {
    // transaction=false: we manage transactions ourselves (see transaction()).
    const result = await this.conn.run(sql, params, false);
    if (this.depth === 0) await this.save();
    return { changes: result.changes?.changes ?? 0, lastId: result.changes?.lastId ?? 0 };
  }

  async exec(sql: string) {
    await this.conn.execute(sql, false);
    if (this.depth === 0) await this.save();
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn(); // join the outer transaction
    await this.conn.beginTransaction();
    this.depth = 1;
    try {
      const result = await fn();
      await this.conn.commitTransaction();
      this.depth = 0;
      await this.save();
      return result;
    } catch (e) {
      this.depth = 0;
      await this.conn.rollbackTransaction();
      throw e;
    }
  }

  private async save() {
    if (isWeb) await sqlite.saveToStore(DB_NAME);
  }
}
