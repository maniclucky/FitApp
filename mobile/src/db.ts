// Opens the on-device SQLite database. On Android/iOS this is a native SQLite file
// (Capacitor plugin); in a browser the same API is backed by sql.js (WebAssembly) and
// saved to the browser's IndexedDB via the <jeep-sqlite> element.
import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from "@capacitor-community/sqlite";
import { defineCustomElements as defineJeepSqlite } from "jeep-sqlite/loader";

export const DB_NAME = "fitapp";
const sqlite = new SQLiteConnection(CapacitorSQLite);
export const isWeb = Capacitor.getPlatform() === "web";

export async function openDatabase(): Promise<SQLiteDBConnection> {
  if (isWeb) {
    defineJeepSqlite(window);
    document.body.appendChild(document.createElement("jeep-sqlite"));
    await customElements.whenDefined("jeep-sqlite");
    await sqlite.initWebStore();
  }
  const db = await sqlite.createConnection(DB_NAME, false, "no-encryption", 1, false);
  await db.open();
  return db;
}

/** In a browser, writes are in memory until saved to IndexedDB; on a phone this is a no-op. */
export async function persist(): Promise<void> {
  if (isWeb) await sqlite.saveToStore(DB_NAME);
}
