// Routines (ordered sets of workouts) with volume-planning targets, and the next-workout
// rotation used by the day view. Ported from app.py.
import { type Db, get, utcNow } from "../db/types";
import { NotFoundError } from "./errors";
import { orderedMuscleGroups } from "./muscles";
import { cleanName, formatNumber, parseLogValue, ValidationError } from "./text";

export interface Routine {
  id: number;
  name: string;
  cycle_days: number;
  /** Workout ids in order (repeats allowed). */
  workout_ids: number[];
  /** muscle_group_id -> weekly minimum (null = saved blank). Empty if never saved with targets. */
  targets: Map<number, number | null>;
}

export async function listRoutines(db: Db, ids?: number[]): Promise<Routine[]> {
  const where = ids ? `WHERE id IN (${ids.map(() => "?").join(",") || "NULL"})` : "";
  const routines = await db.all(`SELECT id, name, cycle_days FROM routine ${where} ORDER BY name`, ids ?? []);
  const slots = await db.all("SELECT routine_id, workout_id FROM routine_workout ORDER BY routine_id, position");
  const targets = await db.all("SELECT routine_id, muscle_group_id, sets FROM routine_muscle_target ORDER BY rowid");
  return routines.map((r) => ({
    id: r.id, name: r.name, cycle_days: r.cycle_days,
    workout_ids: slots.filter((s) => s.routine_id === r.id).map((s) => s.workout_id),
    targets: new Map(targets.filter((t) => t.routine_id === r.id).map((t) => [t.muscle_group_id, t.sets])),
  }));
}

export async function getRoutine(db: Db, id: number): Promise<Routine> {
  const [routine] = await listRoutines(db, [id]);
  if (!routine) throw new NotFoundError("That routine no longer exists.");
  return routine;
}

/** Validate the editor's list of workout ids (JSON string or array). */
export function parseRoutineWorkoutIds(raw: unknown, workoutIds: Set<number>): { ids: number[]; errors: string[] } {
  let data: unknown = raw;
  if (typeof raw === "string" || raw == null) {
    try {
      data = JSON.parse((raw as string) || "[]");
    } catch {
      data = null;
    }
  }
  if (!Array.isArray(data)) return { ids: [], errors: ["Couldn’t read the routine. Please try again."] };
  const ids = data.filter((i): i is number => typeof i === "number" && Number.isInteger(i) && workoutIds.has(i));
  return { ids, errors: ids.length === data.length ? [] : ["One of the selected workouts no longer exists."] };
}

export interface RoutineForm {
  name: string;
  workout_ids: unknown;
  cycle_days: string;
  /** muscle_group_id -> the text in its target input. */
  targets: Record<number, string>;
}

export type SaveRoutineResult =
  | { ok: true; id: number; name: string }
  | { ok: false; errors: string[]; badTargets: Set<number>; form: { name: string; workout_ids: number[]; cycle_days: string; targets: Record<number, string> } };

/** Create (id null) or replace a routine: name, workouts, cycle length and a target for every muscle group. */
export async function saveRoutine(db: Db, id: number | null, input: RoutineForm): Promise<SaveRoutineResult> {
  if (id !== null) await getRoutine(db, id);
  const name = cleanName(input.name ?? "", 100);
  const workoutIds = new Set((await db.all("SELECT id FROM workout")).map((w) => w.id as number));
  const { ids, errors } = parseRoutineWorkoutIds(input.workout_ids, workoutIds);
  const duplicate = await get(db, "SELECT id FROM routine WHERE name = ? AND id IS NOT ?", [name, id]);
  if (!name) errors.unshift("Name is required.");
  else if (duplicate) errors.unshift(`A routine named “${name}” already exists.`);
  if (!ids.length && !errors.length) errors.push("Add at least one workout.");

  const cycle = (input.cycle_days ?? "").trim();
  if (!/^\d+$/.test(cycle) || !(Number(cycle) >= 1 && Number(cycle) <= 365)) {
    errors.push("Days to complete the routine must be a whole number from 1 to 365.");
  }
  const badTargets = new Set<number>();
  const texts: Record<number, string> = {};
  const parsed = new Map<number, number | null>();
  for (const mg of await orderedMuscleGroups(db)) {
    const raw = (input.targets?.[mg.id] ?? "").trim();
    texts[mg.id] = raw;
    try {
      parsed.set(mg.id, parseLogValue(raw, `${mg.name} target`, { integer: false, maximum: 999 }));
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      errors.push(e.message);
      badTargets.add(mg.id);
    }
  }
  if (errors.length) return { ok: false, errors, badTargets, form: { name, workout_ids: ids, cycle_days: cycle, targets: texts } };

  const savedId = await db.transaction(async () => {
    let routineId = id;
    if (routineId === null) {
      routineId = (await db.run("INSERT INTO routine (name, created_at, cycle_days) VALUES (?, ?, ?)", [name, utcNow(), Number(cycle)])).lastId;
    } else {
      await db.run("UPDATE routine SET name = ?, cycle_days = ? WHERE id = ?", [name, Number(cycle), routineId]);
      await db.run("DELETE FROM routine_workout WHERE routine_id = ?", [routineId]);
      await db.run("DELETE FROM routine_muscle_target WHERE routine_id = ?", [routineId]);
    }
    for (const [i, workoutId] of ids.entries()) {
      await db.run("INSERT INTO routine_workout (routine_id, workout_id, position) VALUES (?, ?, ?)", [routineId, workoutId, i + 1]);
    }
    // One row per muscle, blanks included, so a cleared target stays cleared.
    for (const [muscleId, sets] of parsed) {
      await db.run("INSERT INTO routine_muscle_target (routine_id, muscle_group_id, sets) VALUES (?, ?, ?)", [routineId, muscleId, sets]);
    }
    return routineId;
  });
  return { ok: true, id: savedId, name };
}

export async function deleteRoutine(db: Db, id: number): Promise<string> {
  const routine = await getRoutine(db, id);
  await db.run("DELETE FROM routine WHERE id = ?", [id]);
  return routine.name;
}

/** The target inputs' initial text: the routine's saved targets, or blank for a new routine. */
export function targetTexts(routine: Routine | null): Record<number, string> {
  return Object.fromEntries([...(routine?.targets ?? new Map())].map(([k, v]) => [k, formatNumber(v)]));
}

/**
 * 0-based index of the routine's next workout for `date`, inferred from logged history.
 * Finds the most recently logged workout (on or before date) that belongs to the routine and
 * continues the cycle after it. When the routine repeats a workout (A / B / A), the slot is
 * chosen by how far back recent history matches the cycle. No history -> the first workout.
 */
export async function routineNextIndex(db: Db, routine: Routine, date: string): Promise<number> {
  const order = routine.workout_ids;
  const unique = [...new Set(order)];
  const rows = await db.all(
    `SELECT date, workout_id, MIN(position) AS first FROM log_exercise
     WHERE workout_id IN (${unique.map(() => "?").join(",") || "NULL"}) AND date <= ?
     GROUP BY date, workout_id ORDER BY date DESC, first DESC LIMIT ?`,
    [...unique, date, order.length * 3],
  );
  const history = rows.map((r) => r.workout_id as number); // most recent first
  if (!history.length) return 0;
  const n = order.length;
  const mod = (a: number) => ((a % n) + n) % n; // Python's % (never negative)
  let best: [number, number] | null = null;
  for (let p = 0; p < n; p++) {
    if (order[p] !== history[0]) continue;
    let k = 1;
    while (k < Math.min(history.length, n) && history[k] === order[mod(p - k)]) k++;
    if (best === null || k > best[0]) best = [k, p];
  }
  return (best![1] + 1) % n;
}
