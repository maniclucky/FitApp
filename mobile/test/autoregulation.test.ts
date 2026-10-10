import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/schema";
import { isDeload, nextTargets, type PreviousSet, repRange, setDeload } from "../src/logic/autoregulation";
import { addExercises, addLogSet, autoregulateEntry, clearDay, dayEntries, loadRoutine, loadWorkout, updateSet } from "../src/logic/day";
import { saveExercise } from "../src/logic/exercises";
import { syncMuscleGroups } from "../src/logic/muscles";
import { getRoutine, saveRoutine } from "../src/logic/routines";
import { saveWorkout, type WorkoutSet } from "../src/logic/workouts";
import { openTestDb } from "./sqljs";

const plan = (min: number | null, max: number | null, weight: number | null = 135): WorkoutSet =>
  ({ id: 0, position: 1, reps_min: min, reps_max: max, is_amrap: false, weight, duration_seconds: null, distance: null });
const done = (reps: number, weight: number | null, target_reps: number | null, target_weight: number | null = weight): PreviousSet =>
  ({ reps, weight, completed_at: "2026-10-01 10:00:00", target_reps, target_weight });

describe("autoregulation rules", () => {
  it("follows the agreed examples (range 8–12)", () => {
    const p = plan(8, 12);
    expect(nextTargets(done(10, 135, 10), p, true)).toEqual({ reps: 11, weight: 135 }); // hit target: +1
    expect(nextTargets(done(9, 135, 10), p, true)).toEqual({ reps: 9, weight: 135 }); // short: what was reached
    expect(nextTargets(done(12, 135, 12), p, true)).toEqual({ reps: 8, weight: 140 }); // past the top: +5 lb at min
    expect(nextTargets(done(7, 135, 10), p, true)).toEqual({ reps: 8, weight: 130 }); // under the min: -5 lb at min
    expect(nextTargets(done(13, 135, 10), p, true)).toEqual({ reps: 8, weight: 140 }); // 14 > 12
    expect(nextTargets(done(11, 135, 10), p, true)).toEqual({ reps: 12, weight: 135 }); // beat it: actual + 1
  });

  it("compares the first autoregulated session with the range minimum", () => {
    expect(nextTargets(done(8, 135, null), plan(8, 12), true)).toEqual({ reps: 9, weight: 135 });
  });

  it("carries the previous targets forward when the set wasn't checked off", () => {
    const prev = { ...done(12, 140, 10, 140), completed_at: null };
    expect(nextTargets(prev, plan(8, 12), true)).toEqual({ reps: 10, weight: 140 });
    expect(nextTargets({ ...done(0, null, null, null), reps: null }, plan(8, 12, 95), true)).toEqual({ reps: null, weight: 95 });
  });

  it("defaults a missing range end to 8–15", () => {
    expect(repRange({ reps_min: null, reps_max: null })).toEqual({ min: 8, max: 15 });
    expect(repRange({ reps_min: 10, reps_max: null })).toEqual({ min: 10, max: 15 });
    expect(repRange({ reps_min: 20, reps_max: null })).toEqual({ min: 20, max: 20 });
    expect(repRange({ reps_min: null, reps_max: 5 })).toEqual({ min: 5, max: 5 });
    expect(nextTargets(done(15, 100, 15), plan(null, null), true)).toEqual({ reps: 8, weight: 105 });
  });

  it("never drops the weight below 0, and holds bodyweight sets at the top of the range", () => {
    expect(nextTargets(done(3, 2.5, 8), plan(8, 12), true)).toEqual({ reps: 8, weight: 0 });
    expect(nextTargets(done(12, null, 12, null), plan(8, 12, null), true)).toEqual({ reps: 12, weight: null });
    expect(nextTargets(done(12, null, 12, null), plan(8, 12, null), false)).toEqual({ reps: 12, weight: null });
  });

  it("progresses AMRAP reps with no range and never changes their weight", () => {
    const amrap = { ...plan(null, null, 135), is_amrap: true };
    expect(nextTargets(done(20, 95, null), amrap, true)).toEqual({ reps: 21, weight: 95 }); // first time: beat
    expect(nextTargets(done(21, 95, 21), amrap, true)).toEqual({ reps: 22, weight: 95 });
    expect(nextTargets(done(3, 95, 21), amrap, true)).toEqual({ reps: 3, weight: 95 }); // short: match, no -5 lb
    expect(nextTargets(done(40, null, 30, null), amrap, true)).toEqual({ reps: 41, weight: 135 }); // plan weight
    expect(nextTargets({ ...done(25, 95, 21), completed_at: null }, amrap, true)).toEqual({ reps: 21, weight: 95 });
  });

  it("uses the target weight when no weight was typed", () => {
    expect(nextTargets(done(10, null, 10, 135), plan(8, 12), true)).toEqual({ reps: 11, weight: 135 });
  });
});

async function setup() {
  const db = await openTestDb();
  await migrate(db);
  await syncMuscleGroups(db);
  const ex = async (name: string, tracking = ["weight", "reps"]) => {
    const r = await saveExercise(db, null, { name, tracking, primary: ["Chest"], ancillary: [], note: "" });
    if (!r.ok) throw new Error(r.errors.join());
    return r.id;
  };
  const bench = await ex("Bench");
  const row = await ex("Row");
  const dip = await ex("Dip", ["reps"]);
  const set = (min: number | null, max: number | null, weight: number | null = null, amrap = false) =>
    ({ min, max, amrap, weight, time: null, distance: null });
  const items = (order: number[]) => order.map((id) => ({
    exercise_id: id, superset_next: false,
    sets: id === bench ? [set(8, 12, 135), set(8, 12, 135), set(null, null, null, true)]
      : id === row ? [set(null, null, 100)] : [set(6, 10)],
  }));
  const w = await saveWorkout(db, null, "Push", JSON.stringify(items([bench, row, dip])));
  if (!w.ok) throw new Error(w.errors.join());
  const r = await saveRoutine(db, null, { name: "R", workout_ids: [w.id], cycle_days: "7", autoregulate: true, targets: {} });
  if (!r.ok) throw new Error(r.errors.join());
  return { db, bench, row, dip, workoutId: w.id, routineId: r.id, items };
}

type Ctx = Awaited<ReturnType<typeof setup>>;
const sets = async ({ db }: Ctx, date: string, exerciseId: number) =>
  (await dayEntries(db, date)).find((lx) => lx.exercise.id === exerciseId)!.sets;
/** Logs completed sets for an exercise on a day: [reps, weight][] by set. */
async function log(c: Ctx, date: string, exerciseId: number, values: [number, number | null][]) {
  const s = await sets(c, date, exerciseId);
  for (const [n, [reps, weight]] of values.entries()) await updateSet(c.db, s[n].id, { reps, weight: weight ?? "", completed: true });
}
const targets = async (c: Ctx, date: string, exerciseId: number) =>
  (await sets(c, date, exerciseId)).map((s) => [s.target_reps, s.target_weight, s.target_label]);

describe("autoregulated routine loads", () => {
  it("leaves the first session alone, then adjusts from the last one", async () => {
    const c = await setup();
    await loadRoutine(c.db, "2026-10-01", c.routineId, undefined, true);
    expect(await targets(c, "2026-10-01", c.bench)).toEqual([[null, 135, "8–12"], [null, 135, "8–12"], [null, null, "AMRAP"]]);
    await log(c, "2026-10-01", c.bench, [[12, 135], [7, 135], [20, 95]]);
    await log(c, "2026-10-01", c.row, [[10, 100]]);
    await log(c, "2026-10-01", c.dip, [[10, null]]);

    await loadRoutine(c.db, "2026-10-03", c.routineId, undefined, true);
    // 12 is the top: +5 lb at 8. 7 is under 8: -5 lb at 8. AMRAP: reps + 1, weight carried over.
    expect(await targets(c, "2026-10-03", c.bench)).toEqual([[8, 140, "8"], [8, 130, "8"], [21, 95, "21"]]);
    expect(await targets(c, "2026-10-03", c.row)).toEqual([[11, 100, "11"]]); // no range: 8–15
    expect(await targets(c, "2026-10-03", c.dip)).toEqual([[10, null, "10"]]); // bodyweight holds at the top
    // "+ Set" copies the autoregulated target too.
    const entry = (await dayEntries(c.db, "2026-10-03")).find((lx) => lx.exercise.id === c.row)!;
    await addLogSet(c.db, entry.id);
    expect((await targets(c, "2026-10-03", c.row))[1]).toEqual([11, 100, "11"]);
  });

  it("does nothing when the Settings switch is off, whatever the routine's old flag says", async () => {
    const c = await setup(); // the routine still has autoregulate = 1 stored
    expect((await getRoutine(c.db, c.routineId)).autoregulate).toBe(true);
    await loadRoutine(c.db, "2026-10-01", c.routineId);
    await log(c, "2026-10-01", c.bench, [[10, 135]]);
    await loadRoutine(c.db, "2026-10-03", c.routineId);
    await loadWorkout(c.db, "2026-10-05", c.workoutId);
    await addExercises(c.db, "2026-10-07", [c.bench]);
    expect((await targets(c, "2026-10-03", c.bench))[0]).toEqual([null, 135, "8–12"]);
    expect((await targets(c, "2026-10-05", c.bench))[0]).toEqual([null, 135, "8–12"]);
    expect((await targets(c, "2026-10-07", c.bench))[0]).toEqual([null, null, ""]);
  });

  it("autoregulates a workout loaded on its own from that workout's last session, whatever its source", async () => {
    const c = await setup();
    await loadRoutine(c.db, "2026-10-01", c.routineId); // logged through the routine
    await log(c, "2026-10-01", c.bench, [[10, 135]]);
    await addExercises(c.db, "2026-10-02", [c.bench]); // a later ad-hoc bench doesn't count for the workout
    await log(c, "2026-10-02", c.bench, [[5, 95]]);
    await loadWorkout(c.db, "2026-10-03", c.workoutId, true);
    expect((await targets(c, "2026-10-03", c.bench))[0]).toEqual([11, 135, "11"]);
  });

  it("autoregulates exercises added on their own from each one's last session", async () => {
    const c = await setup();
    await loadWorkout(c.db, "2026-10-01", c.workoutId); // range 8–12 there; the ad-hoc entry has none (8–15)
    await log(c, "2026-10-01", c.bench, [[12, 135], [10, 135]]);
    await log(c, "2026-10-01", c.dip, [[9, null]]);
    await addExercises(c.db, "2026-10-03", [c.bench, c.dip, c.row], true);
    expect(await targets(c, "2026-10-03", c.bench)).toEqual([[13, 135, "13"], [11, 135, "11"], [null, null, ""]]);
    expect(await targets(c, "2026-10-03", c.dip)).toEqual([[10, null, "10"], [null, null, ""], [null, null, ""]]);
    // Row was on that day but never checked off: its previous targets carry forward.
    expect(await targets(c, "2026-10-03", c.row)).toEqual([[null, 100, ""], [null, null, ""], [null, null, ""]]);
  });

  it("skips deload days and uses the previous non-deload session", async () => {
    const c = await setup();
    await loadRoutine(c.db, "2026-10-01", c.routineId, undefined, true);
    await log(c, "2026-10-01", c.bench, [[10, 135]]);
    await loadWorkout(c.db, "2026-10-03", c.workoutId); // any source counts
    await log(c, "2026-10-03", c.bench, [[8, 95]]);
    await setDeload(c.db, "2026-10-03", true);
    await loadRoutine(c.db, "2026-10-05", c.routineId, undefined, true);
    expect((await targets(c, "2026-10-05", c.bench))[0]).toEqual([11, 135, "11"]);
    await setDeload(c.db, "2026-10-03", false);
    await loadRoutine(c.db, "2026-10-04", c.routineId, undefined, true);
    expect((await targets(c, "2026-10-04", c.bench))[0]).toEqual([9, 95, "9"]);
    await setDeload(c.db, "2026-10-04", true);
    await clearDay(c.db, "2026-10-04"); // clearing a day removes its deload mark (user)
    expect(await isDeload(c.db, "2026-10-04")).toBe(false);
  });

  it("matches rearranged exercises, and a replaced one uses the exercise's own history", async () => {
    const c = await setup();
    const fly = (await saveExercise(c.db, null, { name: "Fly", tracking: ["weight", "reps"], primary: ["Chest"], ancillary: [], note: "" }));
    if (!fly.ok) throw new Error();
    await loadRoutine(c.db, "2026-10-01", c.routineId, undefined, true);
    await log(c, "2026-10-01", c.bench, [[10, 135]]);
    await log(c, "2026-10-01", c.dip, [[6, null]]);
    // Fly was done on its own earlier, outside the workout.
    await addExercises(c.db, "2026-09-20", [fly.id]);
    await log(c, "2026-09-20", fly.id, [[9, 30]]);
    // Rearranged, and Row replaced by Fly.
    const items = c.items([c.dip, c.bench]);
    items.push({ exercise_id: fly.id, superset_next: false, sets: [{ min: 8, max: 12, amrap: false, weight: null, time: null, distance: null }] });
    const saved = await saveWorkout(c.db, c.workoutId, "Push", JSON.stringify(items));
    expect(saved.ok).toBe(true);
    await loadRoutine(c.db, "2026-10-03", c.routineId, undefined, true);
    expect((await targets(c, "2026-10-03", c.bench))[0]).toEqual([11, 135, "11"]);
    expect(await targets(c, "2026-10-03", c.dip)).toEqual([[7, null, "7"]]);
    expect(await targets(c, "2026-10-03", fly.id)).toEqual([[10, 30, "10"]]);
  });

  it("carries targets forward for sets that weren't checked off", async () => {
    const c = await setup();
    await loadRoutine(c.db, "2026-10-01", c.routineId, undefined, true);
    await log(c, "2026-10-01", c.bench, [[10, 135]]);
    await loadRoutine(c.db, "2026-10-03", c.routineId, undefined, true); // set 1 target 11 @ 135; nothing logged
    await loadRoutine(c.db, "2026-10-05", c.routineId, undefined, true);
    expect((await targets(c, "2026-10-05", c.bench))[0]).toEqual([11, 135, "11"]);
    expect((await targets(c, "2026-10-05", c.bench))[1]).toEqual([null, 135, "8–12"]);
  });
});

describe("AR button (one exercise on a day)", () => {
  it("replaces targets a workout's autoregulation set with the exercise's last session", async () => {
    const c = await setup();
    await loadWorkout(c.db, "2026-09-28", c.workoutId);
    await log(c, "2026-09-28", c.bench, [[10, 135]]);
    await addExercises(c.db, "2026-10-01", [c.bench]); // the exercise's own last session
    await log(c, "2026-10-01", c.bench, [[7, 145]]);
    await loadWorkout(c.db, "2026-10-03", c.workoutId, true);
    const before = await targets(c, "2026-10-03", c.bench);
    expect(before[0]).toEqual([11, 135, "11"]); // from the workout's last session
    const id = (await dayEntries(c.db, "2026-10-03")).find((lx) => lx.exercise.id === c.bench)!.id;
    expect(await autoregulateEntry(c.db, id)).toBe("2026-10-01");
    expect((await targets(c, "2026-10-03", c.bench))[0]).toEqual([8, 140, "8"]); // 7 < 8: -5 lb at the min
  });

  const entryId = async (c: Ctx, date: string, exerciseId: number) =>
    (await dayEntries(c.db, date)).find((lx) => lx.exercise.id === exerciseId)!.id;

  it("uses the exercise's latest earlier non-deload entry from any source", async () => {
    const c = await setup();
    await loadWorkout(c.db, "2026-09-28", c.workoutId); // from the workout: range 8–12
    await log(c, "2026-09-28", c.bench, [[10, 135], [12, 135]]);
    await addExercises(c.db, "2026-10-01", [c.bench]); // ad hoc, later, but a deload day
    await log(c, "2026-10-01", c.bench, [[5, 95]]);
    await setDeload(c.db, "2026-10-01", true);
    await addExercises(c.db, "2026-10-03", [c.bench]); // ad hoc: no range, so 8–15
    expect(await autoregulateEntry(c.db, await entryId(c, "2026-10-03", c.bench))).toBe("2026-09-28");
    // 10 vs the first-time target (8): 11. 12 -> 13, within 8–15. Set 3 had no reference set.
    expect(await targets(c, "2026-10-03", c.bench)).toEqual([[11, 135, "11"], [13, 135, "13"], [null, null, ""]]);
  });

  it("leaves completed sets and fields that already have a value alone", async () => {
    const c = await setup();
    await addExercises(c.db, "2026-09-28", [c.bench]);
    await log(c, "2026-09-28", c.bench, [[10, 135], [10, 135], [10, 135]]);
    await addExercises(c.db, "2026-10-03", [c.bench]);
    const s = await sets(c, "2026-10-03", c.bench);
    await updateSet(c.db, s[0].id, { reps: 9, weight: 100, completed: true }); // done
    await updateSet(c.db, s[1].id, { weight: 120 }); // weight typed, reps empty
    await autoregulateEntry(c.db, await entryId(c, "2026-10-03", c.bench));
    expect(await targets(c, "2026-10-03", c.bench)).toEqual([[null, null, ""], [11, null, "11"], [11, 135, "11"]]);
    const after = await sets(c, "2026-10-03", c.bench);
    expect(after.map((x) => [x.reps, x.weight])).toEqual([[9, 100], [null, 120], [null, null]]);
  });

  it("returns null with no earlier entry, and refuses exercises without reps", async () => {
    const c = await setup();
    await addExercises(c.db, "2026-10-03", [c.bench]);
    expect(await autoregulateEntry(c.db, await entryId(c, "2026-10-03", c.bench))).toBeNull();
    expect(await targets(c, "2026-10-03", c.bench)).toEqual([[null, null, ""], [null, null, ""], [null, null, ""]]);
    const plank = await saveExercise(c.db, null, { name: "Plank", tracking: ["time"], primary: ["Abs"], ancillary: [], note: "" });
    if (!plank.ok) throw new Error(plank.errors.join());
    await addExercises(c.db, "2026-10-03", [plank.id]);
    await expect(autoregulateEntry(c.db, await entryId(c, "2026-10-03", plank.id))).rejects.toThrow("tracks reps");
  });
});
