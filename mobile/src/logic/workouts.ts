// Workouts (plans built in the workout builder). Ported from app.py / models.py.
import { type Db, get, type Row, utcNow } from "../db/types";
import { NotFoundError } from "./errors";
import { type Exercise, listExercises } from "./exercises";
import {
  cleanName, formatG, MUSCLE_ROLES, type MuscleRole, parseDuration, parseLogValue, parseReps, pyTruthy, setTargetLabel, ValidationError,
} from "./text";

export interface WorkoutSet {
  id: number;
  position: number;
  reps_min: number | null;
  reps_max: number | null;
  is_amrap: boolean;
  weight: number | null;
  duration_seconds: number | null;
  distance: number | null;
}

export interface WorkoutSlot {
  id: number;
  exercise: Exercise;
  position: number;
  superset_group: number | null;
  sets: WorkoutSet[];
}

export interface Workout {
  id: number;
  name: string;
  slots: WorkoutSlot[];
}

/** Consecutive items sharing a non-null superset_group form one block (for display). */
export function groupBlocks<T extends { superset_group: number | null }>(slots: T[]): T[][] {
  const blocks: T[][] = [];
  for (const slot of slots) {
    const last = blocks.at(-1);
    if (last && slot.superset_group !== null && last.at(-1)!.superset_group === slot.superset_group) last.push(slot);
    else blocks.push([slot]);
  }
  return blocks;
}

export const setLabel = (s: WorkoutSet) =>
  setTargetLabel(s.reps_min, s.reps_max, s.is_amrap, s.weight, s.duration_seconds, s.distance);

/** e.g. "3 × 8–12 @ 135 lb", "4 sets: 6–8, 6–8, 6–8, AMRAP @ 135 lb", "1 × 25:00 · 3 mi", or "2 sets". */
export function slotSummary(slot: WorkoutSlot): string {
  const n = slot.sets.length;
  let labels = slot.sets.map(setLabel);
  if (!labels.some(Boolean)) return n === 1 ? `${n} set` : `${n} sets`;
  if (new Set(labels).size === 1) return `${n} × ${labels[0]}`;
  // Sets differ; if they all share a weight, say it once at the end.
  const weights = new Set(slot.sets.map((s) => s.weight));
  let suffix = "";
  if (weights.size === 1 && !weights.has(null)) {
    suffix = ` @ ${formatG([...weights][0]!)} lb`;
    labels = slot.sets.map((s) => setTargetLabel(s.reps_min, s.reps_max, s.is_amrap, null, s.duration_seconds, s.distance));
  }
  return `${n} sets: ` + labels.map((l) => l || "—").join(", ") + suffix;
}

function toSet(r: Row): WorkoutSet {
  return {
    id: r.id, position: r.position, reps_min: r.reps_min, reps_max: r.reps_max, is_amrap: Boolean(r.is_amrap),
    weight: r.weight, duration_seconds: r.duration_seconds, distance: r.distance,
  };
}

/** Workouts by name (or just `ids`), with their slots, exercises and planned sets in order. */
export async function listWorkouts(db: Db, ids?: number[]): Promise<Workout[]> {
  const where = ids ? `WHERE id IN (${ids.map(() => "?").join(",") || "NULL"})` : "";
  const workouts = await db.all(`SELECT id, name FROM workout ${where} ORDER BY name`, ids ?? []);
  if (!workouts.length) return [];
  const slots = await db.all("SELECT * FROM workout_exercise ORDER BY workout_id, position");
  const sets = await db.all("SELECT * FROM workout_set ORDER BY workout_exercise_id, position");
  const exercises = new Map((await listExercises(db)).map((e) => [e.id, e]));
  const setsBySlot = new Map<number, WorkoutSet[]>();
  for (const s of sets) {
    if (!setsBySlot.has(s.workout_exercise_id)) setsBySlot.set(s.workout_exercise_id, []);
    setsBySlot.get(s.workout_exercise_id)!.push(toSet(s));
  }
  return workouts.map((w) => ({
    id: w.id,
    name: w.name,
    slots: slots.filter((wx) => wx.workout_id === w.id).map((wx) => ({
      id: wx.id, position: wx.position, superset_group: wx.superset_group,
      exercise: exercises.get(wx.exercise_id)!, sets: setsBySlot.get(wx.id) ?? [],
    })),
  }));
}

export async function getWorkout(db: Db, id: number): Promise<Workout> {
  const [workout] = await listWorkouts(db, [id]);
  if (!workout) throw new NotFoundError("That workout no longer exists.");
  return workout;
}

/** Why a workout can't be deleted (a routine uses it), or null. */
export async function workoutDeleteBlocker(db: Db, id: number): Promise<string | null> {
  const names = [...new Set((await db.all(
    "SELECT r.name FROM routine r JOIN routine_workout rw ON rw.routine_id = r.id WHERE rw.workout_id = ?", [id],
  )).map((r) => r.name as string))].sort();
  if (!names.length) return null;
  return `It’s used in ${names.join(", ")}. Remove it from ${names.length > 1 ? "those routines" : "that routine"} first.`;
}

// ---------- Builder items ----------

/** One planned set as the builder edits it. weight/time/distance may be text typed by the user. */
export interface ItemSet {
  min: number | null;
  max: number | null;
  amrap: boolean;
  weight: unknown;
  time: unknown;
  distance: unknown;
}
export interface Item {
  exercise_id: number;
  superset_next: boolean;
  sets: ItemSet[];
}

// Planned-set targets other than reps: builder key -> [workout_set column, tracking mode].
export const SET_TARGETS = {
  weight: ["weight", "weight"],
  time: ["duration_seconds", "time"],
  distance: ["distance", "distance"],
} as const;

function parseSetTarget(key: keyof typeof SET_TARGETS, value: unknown, label: string): number | null {
  if (key === "time") return parseDuration(value, label);
  const v = typeof value === "string" ? value.trim() : value;
  const [name, maximum] = key === "weight" ? ["Weight", 10_000] : ["Distance", 1_000];
  try {
    return parseLogValue(v, name, { integer: false, maximum });
  } catch (e) {
    const m = (e as Error).message;
    throw new ValidationError(`${label}: ${m[0].toLowerCase()}${m.slice(1)}`);
  }
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate the builder's payload (a JSON string or already-parsed value). Returns normalized
 * items, safe to re-render in the builder and (when errors is empty) to save.
 */
export function parseWorkoutItems(raw: unknown, exercisesById: Map<number, Exercise>): { items: Item[]; errors: string[] } {
  let data: unknown = raw;
  if (typeof raw === "string" || raw == null) {
    try {
      data = JSON.parse((raw as string) || "[]");
    } catch {
      return { items: [], errors: ["Couldn’t read the workout. Please try again."] };
    }
  }
  if (!Array.isArray(data)) return { items: [], errors: ["Couldn’t read the workout. Please try again."] };

  const items: Item[] = [];
  const errors: string[] = [];
  for (const entry of data) {
    if (!isObject(entry)) continue;
    const id = entry.exercise_id;
    const exercise = typeof id === "number" && Number.isInteger(id) ? exercisesById.get(id) : undefined;
    if (!exercise) {
      errors.push("One of the selected exercises no longer exists.");
      continue;
    }
    const sets: ItemSet[] = [];
    const rawSets: unknown[] = Array.isArray(entry.sets) ? entry.sets : [];
    rawSets.forEach((rs, i) => {
      const n = i + 1;
      const rawSet = isObject(rs) ? rs : {};
      const amrap = pyTruthy(rawSet.amrap) && exercise.tracks.reps;
      let lo: number | null = null;
      let hi: number | null = null;
      if (exercise.tracks.reps && !amrap) {
        try {
          lo = parseReps(rawSet.min);
          hi = parseReps(rawSet.max);
        } catch {
          errors.push(`${exercise.name}, set ${n}: reps must be whole numbers from 1 to 999.`);
          lo = hi = null;
        }
        if (lo !== null && hi !== null && lo > hi) errors.push(`${exercise.name}, set ${n}: minimum reps can’t exceed maximum.`);
      }
      const targets: Record<string, number | null> = {};
      for (const key of Object.keys(SET_TARGETS) as (keyof typeof SET_TARGETS)[]) {
        targets[key] = null;
        if (exercise.tracks[SET_TARGETS[key][1]]) {
          try {
            targets[key] = parseSetTarget(key, rawSet[key], `${exercise.name}, set ${n}`);
          } catch (e) {
            if (!(e instanceof ValidationError)) throw e;
            errors.push(e.message);
          }
        }
      }
      sets.push({ min: lo, max: hi, amrap, weight: targets.weight, time: targets.time, distance: targets.distance });
    });
    if (!sets.length) errors.push(`${exercise.name} needs at least one set.`);
    items.push({ exercise_id: exercise.id, superset_next: pyTruthy(entry.superset_next), sets });
  }
  if (items.length) items.at(-1)!.superset_next = false; // nothing to link to
  return { items, errors };
}

/** The builder's items for a saved workout (inverse of saving). */
export function workoutToItems(workout: Workout): Item[] {
  const slots = workout.slots;
  return slots.map((wx, i) => ({
    exercise_id: wx.exercise.id,
    superset_next: wx.superset_group !== null && i + 1 < slots.length && slots[i + 1].superset_group === wx.superset_group,
    sets: wx.sets.map((s) => ({
      min: s.reps_min, max: s.reps_max, amrap: s.is_amrap, weight: s.weight, time: s.duration_seconds, distance: s.distance,
    })),
  }));
}

/** Insert validated items as a workout's slots, numbering supersets 1, 2, ... in order. */
async function insertSlots(db: Db, workoutId: number, items: Item[]) {
  let group: number | null = null;
  let nextGroup = 1;
  let prevLinked = false;
  for (const [i, item] of items.entries()) {
    if (!prevLinked) {
      group = null;
      if (item.superset_next) group = nextGroup++;
    }
    const slotId = (await db.run(
      "INSERT INTO workout_exercise (workout_id, exercise_id, position, superset_group) VALUES (?, ?, ?, ?)",
      [workoutId, item.exercise_id, i + 1, group],
    )).lastId;
    for (const [n, s] of item.sets.entries()) {
      await db.run(
        `INSERT INTO workout_set (workout_exercise_id, position, reps_min, reps_max, is_amrap, weight, duration_seconds, distance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [slotId, n + 1, s.min, s.max, s.amrap ? 1 : 0, s.weight ?? null, s.time ?? null, s.distance ?? null],
      );
    }
    prevLinked = item.superset_next;
  }
}

export type SaveWorkoutResult =
  | { ok: true; id: number; name: string }
  | { ok: false; errors: string[]; name: string; items: Item[] };

/** Create (id null) or replace a workout's name and whole plan. */
export async function saveWorkout(db: Db, id: number | null, rawName: string, rawItems: unknown): Promise<SaveWorkoutResult> {
  if (id !== null) await getWorkout(db, id);
  const name = cleanName(rawName ?? "", 100);
  const exercisesById = new Map((await listExercises(db)).map((e) => [e.id, e]));
  const { items, errors } = parseWorkoutItems(rawItems, exercisesById);
  const duplicate = await get(db, "SELECT id FROM workout WHERE name = ? AND id IS NOT ?", [name, id]);
  if (!name) errors.unshift("Name is required.");
  else if (duplicate) errors.unshift(`A workout named “${name}” already exists.`);
  if (!items.length && !errors.length) errors.push("Add at least one exercise.");
  if (errors.length) return { ok: false, errors, name, items };

  const savedId = await db.transaction(async () => {
    let workoutId = id;
    if (workoutId === null) {
      workoutId = (await db.run("INSERT INTO workout (name, created_at) VALUES (?, ?)", [name, utcNow()])).lastId;
    } else {
      await db.run("UPDATE workout SET name = ? WHERE id = ?", [name, workoutId]);
      // Replace the whole plan (history snapshots targets, so nothing references these rows).
      await db.run("DELETE FROM workout_exercise WHERE workout_id = ?", [workoutId]);
    }
    await insertSlots(db, workoutId, items);
    return workoutId;
  });
  return { ok: true, id: savedId, name };
}

/** Deletes a workout unless a routine uses it; logged days keep their sets. Returns its name. */
export async function deleteWorkout(db: Db, id: number): Promise<string> {
  const workout = await getWorkout(db, id);
  const blocker = await workoutDeleteBlocker(db, id);
  if (blocker) throw new ValidationError(`Can’t delete “${workout.name}”. ${blocker}`);
  await db.run("DELETE FROM workout WHERE id = ?", [id]); // log_exercise.workout_id -> NULL via the FK
  return workout.name;
}

/** {muscle name: {primary, ancillary}} raw set counts for one workout (routine volume planning). */
export function workoutMuscleSets(workout: Workout): Record<string, Record<MuscleRole, number>> {
  const totals: Record<string, Record<MuscleRole, number>> = {};
  for (const wx of workout.slots) {
    for (const role of MUSCLE_ROLES) {
      for (const muscle of wx.exercise[role]) {
        totals[muscle] ??= { primary: 0, ancillary: 0 };
        totals[muscle][role] += wx.sets.length;
      }
    }
  }
  return totals;
}
