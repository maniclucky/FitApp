import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/schema";
import { DEFAULT_EXERCISES, listExercises, seedDefaultExercises } from "../src/logic/exercises";
import { DEFAULT_MUSCLE_GROUPS, syncMuscleGroups } from "../src/logic/muscles";
import { openTestDb } from "./sqljs";

describe("default exercises", () => {
  it("seeds every exercise with known muscle groups, and skips existing names", async () => {
    const db = await openTestDb();
    await migrate(db);
    await syncMuscleGroups(db);
    await db.run("INSERT INTO exercise (name, tracks_reps, created_at) VALUES ('barbell bench press', 1, 'x')");
    await seedDefaultExercises(db);
    await seedDefaultExercises(db);

    const exercises = await listExercises(db);
    expect(DEFAULT_EXERCISES).toHaveLength(96);
    expect(exercises).toHaveLength(96);
    // A misspelled muscle would have been created as a custom group.
    expect((await db.all("SELECT name FROM muscle_group")).map((r) => r.name).sort()).toEqual([...DEFAULT_MUSCLE_GROUPS].sort());

    const byName = new Map(exercises.map((e) => [e.name, e]));
    expect(byName.get("barbell bench press")?.primary).toEqual([]); // the existing one is left alone
    expect(byName.get("Dumbbell Bench Press")).toMatchObject({
      modes: ["weight", "reps"], primary: ["Chest"], ancillary: ["Front Deltoid", "Triceps"],
    });
    expect(byName.get("Dips")).toMatchObject({ primary: ["Triceps"], ancillary: ["Chest"] });
    expect(byName.has("Barbell Glute Press") && byName.has("Glute Press")).toBe(true);
    expect(byName.get("Smith Machine Squat")).toMatchObject({ primary: ["Quads"], ancillary: ["Glutes"] });
    expect(exercises.filter((e) => e.name.startsWith("Smith Machine ")).map((e) => e.name.slice(14).toLowerCase()).sort())
      .toEqual(exercises.filter((e) => e.name.toLowerCase().startsWith("barbell ")).map((e) => e.name.slice(8).toLowerCase()).sort());
    expect(byName.get("Seated Leg Curl")?.ancillary).toEqual([]);
    expect(byName.get("Cable Hip Adductor")?.primary).toEqual(["Adductors"]);
    expect(byName.get("Hip Abductor")?.primary).toEqual(["Abductors"]);
  });
});
