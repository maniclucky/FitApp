import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BackupError, exportBackup, importBackup } from "../src/db/backup";
import { migrate, SCHEMA_VERSION, TABLES } from "../src/db/schema";
import { openTestDb } from "./sqljs";

const FIXTURE = new URL("./fixtures/flask-backup.json", import.meta.url);

async function freshDb() {
  const db = await openTestDb();
  await migrate(db);
  return db;
}

describe("schema", () => {
  it("migrates an empty database to the current version, and is idempotent", async () => {
    const db = await freshDb();
    expect((await db.all("PRAGMA user_version"))[0].user_version).toBe(SCHEMA_VERSION);
    expect(await migrate(db)).toBe(SCHEMA_VERSION); // nothing to do
    const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
    expect(tables.sort()).toEqual([...TABLES].sort());
  });

  it("refuses a database from a newer app", async () => {
    const db = await freshDb();
    await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    await expect(migrate(db)).rejects.toThrow(/newer version/);
  });

  it("cascades deletes and nulls workout links in history", async () => {
    const db = await freshDb();
    await db.exec(`
      INSERT INTO muscle_group (id, name) VALUES (1, 'Chest');
      INSERT INTO exercise (id, name, tracks_weight, tracks_reps, created_at) VALUES (1, 'Bench', 1, 1, 'x');
      INSERT INTO workout (id, name, created_at) VALUES (1, 'Push', 'x');
      INSERT INTO workout_exercise (id, workout_id, exercise_id, position) VALUES (1, 1, 1, 1);
      INSERT INTO workout_set (workout_exercise_id, position) VALUES (1, 1);
      INSERT INTO log_exercise (id, date, position, exercise_id, workout_id) VALUES (1, '2026-09-30', 1, 1, 1);
      INSERT INTO log_set (log_exercise_id, position) VALUES (1, 1);
    `);
    await db.run("DELETE FROM workout WHERE id = 1");
    expect((await db.all("SELECT COUNT(*) AS n FROM workout_set"))[0].n).toBe(0);
    expect((await db.all("SELECT workout_id FROM log_exercise"))[0].workout_id).toBeNull();
    await expect(db.run("DELETE FROM exercise WHERE id = 1")).rejects.toThrow(/FOREIGN KEY/); // logged history keeps it
  });
});

describe("backup", () => {
  it("rejects files that aren't backups, and leaves data untouched on a bad import", async () => {
    const db = await freshDb();
    await db.run("INSERT INTO muscle_group (name) VALUES ('Chest')");
    await expect(importBackup(db, { hello: 1 })).rejects.toBeInstanceOf(BackupError);
    await expect(importBackup(db, { format: "fitapp-backup", version: 1, schema: 99, tables: {} })).rejects.toThrow(/newer version/);
    const bad = { format: "fitapp-backup", version: 1, schema: 1, exported_at: "", tables: {
      muscle_group: [{ id: 1, name: "Quads" }],
      exercise_muscle: [{ exercise_id: 42, muscle_group_id: 1, role: "primary" }], // no exercise 42
    } };
    await expect(importBackup(db, bad)).rejects.toThrow();
    expect((await db.all("SELECT name FROM muscle_group")).map((r) => r.name)).toEqual(["Chest"]);
    await expect(importBackup(db, { ...bad, tables: { muscle_group: [{ id: 1, nope: 2 }] } })).rejects.toThrow(/unknown columns/);
  });

  it.skipIf(!existsSync(FIXTURE))("imports the Flask export and round-trips it exactly", async () => {
    const flask = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const db = await freshDb();
    const counts = await importBackup(db, flask);
    for (const t of TABLES) expect(counts[t], t).toBe(flask.tables[t].length);
    expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
    const again = await exportBackup(db);
    for (const t of TABLES) expect(again.tables[t], t).toEqual(flask.tables[t]);
    // A second import over existing data replaces it rather than duplicating.
    await importBackup(db, again);
    expect((await db.all("SELECT COUNT(*) AS n FROM log_set"))[0].n).toBe(flask.tables.log_set.length);
  });
});
