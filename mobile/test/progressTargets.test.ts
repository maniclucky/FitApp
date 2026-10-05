import { describe, expect, it } from "vitest";
import { exportBackup, importBackup } from "../src/db/backup";
import { migrate, SCHEMA_VERSION } from "../src/db/schema";
import { syncMuscleGroups } from "../src/logic/muscles";
import { progressTargets, replaceProgressTargets, saveProgressTarget } from "../src/logic/progress";
import { openTestDb } from "./sqljs";

async function freshDb() {
  const db = await openTestDb();
  await migrate(db);
  await syncMuscleGroups(db);
  return db;
}
const idOf = async (db: Awaited<ReturnType<typeof freshDb>>, name: string) =>
  (await db.all("SELECT id FROM muscle_group WHERE name = ?", [name]))[0].id as number;

describe("progress targets", () => {
  it("saves, clears, validates and replaces weekly targets", async () => {
    const db = await freshDb();
    const chest = await idOf(db, "Chest");
    const quads = await idOf(db, "Quads");
    expect(await saveProgressTarget(db, chest, "Chest", " 6.5 ")).toBe(6.5);
    await saveProgressTarget(db, quads, "Quads", "4");
    await saveProgressTarget(db, quads, "Quads", "8"); // replaces
    expect(Object.fromEntries(await progressTargets(db))).toEqual({ [chest]: 6.5, [quads]: 8 });
    expect(await saveProgressTarget(db, chest, "Chest", "")).toBeNull(); // blank clears
    expect((await progressTargets(db)).has(chest)).toBe(false);
    await expect(saveProgressTarget(db, chest, "Chest", "-1")).rejects.toThrow();
    await expect(saveProgressTarget(db, chest, "Chest", "1000")).rejects.toThrow();

    await replaceProgressTargets(db, new Map([[chest, 10]]));
    const all = await progressTargets(db);
    expect(all.get(chest)).toBe(10);
    expect(all.get(quads)).toBe(0); // a group the preset lacks gets 0
    expect(all.size).toBe((await db.all("SELECT id FROM muscle_group")).length);
  });

  it("round-trips through a backup, and a schema 1 backup imports with no targets", async () => {
    const db = await freshDb();
    await saveProgressTarget(db, await idOf(db, "Chest"), "Chest", "5");
    const backup = await exportBackup(db);
    expect(backup.schema).toBe(SCHEMA_VERSION);
    const other = await freshDb();
    await importBackup(other, backup);
    expect([...(await progressTargets(other)).values()]).toEqual([5]);
    const { progress_target: _, ...older } = backup.tables;
    await importBackup(other, { ...backup, schema: 1, tables: older });
    expect((await progressTargets(other)).size).toBe(0);
  });
});
