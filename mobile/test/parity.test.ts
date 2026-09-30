// Parity: replays test/parity/scenario.json against the TypeScript logic, starting from the
// same data the Flask oracle started from, and compares every result and the final contents
// of every table with what Flask produced (test/parity/oracle_scenario.py).
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { importBackup } from "../src/db/backup";
import { migrate, TABLES } from "../src/db/schema";
import type { Db } from "../src/db/types";
import * as day from "../src/logic/day";
import { NotFoundError } from "../src/logic/errors";
import { deleteExercise, exerciseDeleteBlocker, exercisePickerData, getExercise, listExercises, saveExercise } from "../src/logic/exercises";
import { exerciseHistory, setResult } from "../src/logic/history";
import { deletePreset, savePreset } from "../src/logic/presets";
import { progressData, progressRange } from "../src/logic/progress";
import { deleteRoutine, getRoutine, routineNextIndex, saveRoutine } from "../src/logic/routines";
import { formatVolume, truncate1, ValidationError } from "../src/logic/text";
import { deleteWorkout, groupBlocks, listWorkouts, saveWorkout, slotSummary, workoutDeleteBlocker } from "../src/logic/workouts";
import { openTestDb } from "./sqljs";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const ready = existsSync(fixture("scenario-start.json")) && existsSync(fixture("scenario-expected.json"));

async function resolve(db: Db, v: any): Promise<any> {
  if (Array.isArray(v)) return Promise.all(v.map((x) => resolve(db, x)));
  if (v === "NOTE_501") return "x".repeat(501);
  if (!v || typeof v !== "object") return v;
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0].startsWith("$")) {
    const [kind, ref] = [keys[0], v[keys[0]]];
    const table = ({ $exercise: "exercise", $workout: "workout", $routine: "routine", $preset: "target_preset", $muscle: "muscle_group" } as Record<string, string>)[kind];
    let rows;
    if (table) rows = await db.all(`SELECT id FROM ${table} WHERE name = ?`, [ref]);
    else if (kind === "$entry") rows = await db.all("SELECT id FROM log_exercise WHERE date = ? AND position = ?", ref);
    else rows = await db.all(
      `SELECT ls.id FROM log_set ls JOIN log_exercise lx ON lx.id = ls.log_exercise_id
       WHERE lx.date = ? AND lx.position = ? AND ls.position = ?`, ref);
    return rows[0]?.id ?? -1;
  }
  return Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await resolve(db, v[k])])));
}

const muscleId = async (db: Db, name: string) => (await db.all("SELECT id FROM muscle_group WHERE name = ?", [name]))[0].id;
const byMuscleId = async (db: Db, m: Record<string, string>) =>
  Object.fromEntries(await Promise.all(Object.entries(m).map(async ([k, v]) => [await muscleId(db, k), v])));
const withoutId = ({ id: _id, ...rest }: Record<string, unknown>) => rest;

async function attempt(fn: () => Promise<unknown>) {
  try {
    return { ok: await fn() };
  } catch (e) {
    if (e instanceof NotFoundError) return { error: "notfound", message: e.message };
    if (e instanceof ValidationError || e instanceof Error) return { error: e.message };
    throw e;
  }
}
const saved = (r: any) => (r.ok ? { ok: true } : { errors: r.errors });

async function run(db: Db, step: any, today: string): Promise<any> {
  const s = await resolve(db, step);
  switch (s.op) {
    case "exercise.save": {
      const r = await attempt(() => saveExercise(db, s.id, s.form));
      return "ok" in r ? saved(r.ok) : r;
    }
    case "exercise.delete": {
      const r = await attempt(() => deleteExercise(db, s.id));
      return "ok" in r ? { ok: true } : r;
    }
    case "workout.save":
      return saved(await saveWorkout(db, s.id, s.name, s.items));
    case "workout.delete": {
      const r = await attempt(() => deleteWorkout(db, s.id));
      return "ok" in r ? { ok: true } : r;
    }
    case "routine.save":
      return saved(await saveRoutine(db, s.id, { ...s.form, targets: await byMuscleId(db, s.form.targets) }));
    case "routine.delete":
      return { ok: Boolean(await deleteRoutine(db, s.id)) };
    case "preset.save":
      return saved(await savePreset(db, s.id, s.name, await byMuscleId(db, s.values)));
    case "preset.delete":
      return { ok: Boolean(await deletePreset(db, s.id)) };
    case "day.loadRoutine":
      return attempt(() => day.loadRoutine(db, s.date, s.routine, s.index));
    case "day.loadWorkout":
      return attempt(async () => (await day.loadWorkout(db, s.date, s.workout), true));
    case "day.addExercises":
      return attempt(async () => (await day.addExercises(db, s.date, s.ids), true));
    case "day.reorder": {
      let ids = s.ids;
      if (ids === "ALL_ROTATED_1") {
        ids = (await db.all("SELECT id FROM log_exercise WHERE date = ? ORDER BY position", [s.date])).map((r) => r.id);
        ids = [...ids.slice(1), ...ids.slice(0, 1)];
      }
      return attempt(async () => (await day.reorderDay(db, s.date, ids), true));
    }
    case "day.updateSet":
      return attempt(async () => withoutId(await day.updateSet(db, s.set, s.data)));
    case "day.addSet":
      return attempt(async () => withoutId(await day.addLogSet(db, s.entry)));
    case "day.removeLastSet":
      return attempt(async () => (await day.removeLastLogSet(db, s.entry), true));
    case "day.notes":
      return attempt(() => day.updateNotes(db, s.entry, s.data));
    case "day.deleteEntry":
      return { ok: Boolean(await day.deleteLogEntry(db, s.entry)) };
    case "day.clear":
      return { ok: (await day.clearDay(db, s.date), true) };

    case "read.history": {
      const r = await attempt(() => getExercise(db, s.exercise));
      if (!("ok" in r)) return { error: "notfound" };
      const ex = r.ok as Awaited<ReturnType<typeof getExercise>>;
      return (await exerciseHistory(db, ex, s.before ?? undefined)).map((x) => ({
        date: x.date, workouts: x.workouts, notes: x.notes,
        sets: x.sets.map((ls) => ({ ...withoutId(day.setState(ls)), result: setResult(ls, ex) })),
      }));
    }
    case "read.nextIndex": {
      const routine = await getRoutine(db, s.routine);
      return Promise.all(s.dates.map((d: string) => routineNextIndex(db, routine, d === "TODAY" ? today : d)));
    }
    case "read.progressRange":
      return { error: progressRange(s.start, s.end, today).error };
    case "read.progress": {
      const range = progressRange(s.start, s.end, today);
      const p = await progressData(db, range.start, range.end);
      return {
        days: p.days,
        muscles: p.muscles.map((m) => [m.name, truncate1(m.total), truncate1(m.per_week)]),
        kpis: [formatVolume(p.totalVolume), String(p.trainingDays), String(p.completedSets)],
      };
    }
    case "read.summaries":
      return Object.fromEntries((await listWorkouts(db)).map((w) => [
        w.name, groupBlocks(w.slots).map((block) => block.map((wx) => [wx.exercise.name, slotSummary(wx)])),
      ]));
    case "read.blockers":
      return {
        exercises: Object.fromEntries(await Promise.all((await listExercises(db)).map(async (e) => [e.name, await exerciseDeleteBlocker(db, e.id)]))),
        workouts: Object.fromEntries(await Promise.all((await listWorkouts(db)).map(async (w) => [w.name, await workoutDeleteBlocker(db, w.id)]))),
      };
    case "read.picker":
      return exercisePickerData(db);
    case "read.calendar":
      return day.calendarCounts(db, s.month);
    case "read.day": {
      const entries = await day.dayEntries(db, s.date);
      const rest = day.restAfterSets(day.dayBlocks(entries));
      return entries.map((lx) => ({
        exercise: lx.exercise.name, workout: lx.workout_name, position: lx.position, superset_group: lx.superset_group, note: lx.note,
        sets: lx.sets.map((ls) => ({
          target_label: ls.target_label, target_weight: ls.target_weight,
          target_duration_seconds: ls.target_duration_seconds, target_distance: ls.target_distance,
          rest_after: rest.has(ls.id), ...withoutId(day.setState(ls)), result: setResult(ls, lx.exercise),
        })),
      }));
    }
  }
  throw new Error(`unknown op ${s.op}`);
}

/** Flask reports a missing item as "notfound"/"http 404" (no message) or with its own JSON message. */
function normalize(expected: any, actual: any) {
  if (actual && typeof actual === "object" && actual.error === "notfound") {
    if (expected?.error === "http 404" || expected?.error === "notfound") return [expected, expected];
    return [expected, { error: actual.message }];
  }
  return [expected, actual];
}

async function dump(db: Db) {
  const out: Record<string, any[]> = {};
  for (const table of TABLES) {
    const info = await db.all(`PRAGMA table_info(${table})`);
    const pk = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name as string);
    const rows = await db.all(`SELECT * FROM ${table}`);
    for (const row of rows) for (const k of ["created_at", "completed_at"]) if (k in row) row[k] = row[k] === null ? null : "<ts>";
    out[table] = rows.sort((a, b) => {
      for (const k of pk) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
      return 0;
    });
  }
  return out;
}

it.skipIf(!ready)("replays the Flask scenario with identical results and final data", async () => {
  const start = JSON.parse(readFileSync(fixture("scenario-start.json"), "utf8"));
  const expected = JSON.parse(readFileSync(fixture("scenario-expected.json"), "utf8"));
  const steps = JSON.parse(readFileSync(new URL("./parity/scenario.json", import.meta.url), "utf8")).steps;
  const db = await openTestDb();
  await migrate(db);
  await importBackup(db, start);
  for (const [i, step] of steps.entries()) {
    const [want, got] = normalize(expected.results[i], await run(db, step, expected.today));
    expect(got, `step ${i}: ${step.op}`).toEqual(want);
  }
  const final = await dump(db);
  for (const table of TABLES) expect(final[table], `final ${table}`).toEqual(expected.final[table]);
});
