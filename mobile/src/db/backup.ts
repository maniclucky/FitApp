// Backup files: the whole database as JSON, for Export/Import and for bringing data over
// from the Flask app (scripts/export_for_mobile.py writes the same format).
//
//   { "format": "fitapp-backup", "version": 1, "schema": 1, "exported_at": "...",
//     "tables": { "muscle_group": [{...row}], "exercise": [...], ... } }
//
// Import replaces everything, in one transaction: a bad file leaves the data untouched.
import { SCHEMA_VERSION, TABLES } from "./schema";
import { type Db, type Row, utcNow } from "./types";

export const BACKUP_FORMAT = "fitapp-backup";
export const BACKUP_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  schema: number;
  exported_at: string;
  tables: Record<string, Row[]>;
}

export async function exportBackup(db: Db): Promise<Backup> {
  const tables: Record<string, Row[]> = {};
  for (const table of TABLES) tables[table] = await db.all(`SELECT * FROM ${table} ORDER BY rowid`);
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, schema: SCHEMA_VERSION, exported_at: utcNow(), tables };
}

export class BackupError extends Error {}

/** Replaces all data with the backup's. Returns row counts per table. Throws BackupError. */
export async function importBackup(db: Db, data: unknown): Promise<Record<string, number>> {
  const backup = data as Partial<Backup> | null;
  if (!backup || typeof backup !== "object" || backup.format !== BACKUP_FORMAT) {
    throw new BackupError("That file isn't a FitApp backup.");
  }
  if (backup.version !== BACKUP_VERSION || typeof backup.schema !== "number") {
    throw new BackupError("This backup format isn't supported by this version of FitApp.");
  }
  if (backup.schema > SCHEMA_VERSION) {
    throw new BackupError("This backup is from a newer version of FitApp. Update the app first.");
  }
  // Older backups are upgraded here rather than rejected. Schemas 2 and 3 only added tables
  // (progress_target, deload_day) and columns with defaults (routine.autoregulate,
  // log_set.target_reps), so an older backup (e.g. from Flask) simply has none of them.
  const tables = backup.tables;
  if (!tables || typeof tables !== "object") throw new BackupError("The backup has no data.");
  const unknown = Object.keys(tables).filter((t) => !(TABLES as readonly string[]).includes(t));
  if (unknown.length) throw new BackupError(`The backup has unknown tables: ${unknown.join(", ")}.`);

  const counts: Record<string, number> = {};
  await db.transaction(async () => {
    for (const table of [...TABLES].reverse()) await db.run(`DELETE FROM ${table}`);
    for (const table of TABLES) {
      const rows = tables[table] ?? [];
      if (!Array.isArray(rows)) throw new BackupError(`The backup's ${table} data is malformed.`);
      const columns = new Set((await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name as string));
      for (const row of rows) {
        if (!row || typeof row !== "object") throw new BackupError(`The backup's ${table} data is malformed.`);
        const keys = Object.keys(row);
        const bad = keys.filter((k) => !columns.has(k));
        if (bad.length) throw new BackupError(`The backup's ${table} data has unknown columns: ${bad.join(", ")}.`);
        await db.run(
          `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
          keys.map((k) => row[k]),
        );
      }
      counts[table] = rows.length;
    }
    const broken = await db.all("PRAGMA foreign_key_check");
    if (broken.length) throw new BackupError("The backup's data is inconsistent (broken references).");
  });
  return counts;
}
