// Autoregulation (user requirement, 2026-10-04; not in Flask). A routine with autoregulate on
// adjusts each loaded set's rep and weight targets from the last time the workout was done:
// beat the rep target -> reps + 1; fell short -> what was reached; past the range -> +5 lb at the
// range minimum; under the minimum -> -5 lb at the minimum. Deload days are never the reference.
import { type Db, get } from "../db/types";
import type { WorkoutSet, WorkoutSlot } from "./workouts";

export const DEFAULT_REP_RANGE = { min: 8, max: 15 };
export const WEIGHT_STEP = 5; // lb

/** The rep range autoregulation works within: the plan's, with a blank end defaulting to 8–15. */
export function repRange(set: Pick<WorkoutSet, "reps_min" | "reps_max">): { min: number; max: number } {
  const min = set.reps_min ?? Math.min(DEFAULT_REP_RANGE.min, set.reps_max ?? DEFAULT_REP_RANGE.min);
  return { min, max: set.reps_max ?? Math.max(DEFAULT_REP_RANGE.max, min) };
}

export interface SetTargets {
  reps: number | null;
  weight: number | null;
}

/** The previous session's set, as stored in log_set. */
export interface PreviousSet {
  reps: number | null;
  weight: number | null;
  completed_at: string | null;
  target_reps: number | null;
  target_weight: number | null;
}

/**
 * The next targets for one set, from the same set last time. `plan` gives the rep range and the
 * fallback weight; `tracksWeight` is false for exercises that only track reps.
 */
export function nextTargets(prev: PreviousSet, plan: Pick<WorkoutSet, "reps_min" | "reps_max" | "is_amrap" | "weight">, tracksWeight: boolean): SetTargets {
  const { min, max } = repRange(plan);
  // Not checked off (or no reps typed): carry the previous targets forward unchanged.
  if (prev.completed_at === null || prev.reps === null) {
    return { reps: prev.target_reps ?? null, weight: tracksWeight ? (prev.target_weight ?? plan.weight) : plan.weight };
  }
  const weight: number | null = tracksWeight ? (prev.weight ?? prev.target_weight ?? plan.weight) : null;
  const reps: number = prev.reps;
  // AMRAP (user requirement): reps follow the same +1 / match rule with no range, and the weight
  // is carried over unchanged. Changing it is left to the user.
  if (plan.is_amrap) return { reps: reps >= (prev.target_reps ?? reps) ? reps + 1 : reps, weight };
  const target: number = prev.target_reps ?? min; // the first autoregulated session compares with the minimum
  if (reps < min) return { reps: min, weight: weight === null ? null : Math.max(0, weight - WEIGHT_STEP) };
  const next = reps >= target ? reps + 1 : reps;
  if (next > max) {
    // No weight to raise (bodyweight): hold at the top of the range instead.
    return weight === null ? { reps: max, weight: null } : { reps: min, weight: weight + WEIGHT_STEP };
  }
  return { reps: next, weight: tracksWeight ? weight : plan.weight };
}

export async function isDeload(db: Db, date: string): Promise<boolean> {
  return Boolean(await get(db, "SELECT 1 AS x FROM deload_day WHERE date = ?", [date]));
}

/** Marks or unmarks a day as a deload, which autoregulation then skips as a reference. */
export async function setDeload(db: Db, date: string, on: boolean): Promise<void> {
  await db.run(on ? "INSERT OR IGNORE INTO deload_day (date) VALUES (?)" : "DELETE FROM deload_day WHERE date = ?", [date]);
}

export const NOT_DELOAD = "date NOT IN (SELECT date FROM deload_day)";

/**
 * Targets for every set of the workout's slots when it's loaded on `date`, or null for a set that
 * keeps the plan's targets. The reference is the latest earlier non-deload day the workout was
 * logged (from any source); its exercises are matched to the slots by exercise, in order, so a
 * rearranged workout still lines up. A slot whose exercise wasn't in that session (replaced) uses
 * the exercise's own latest earlier non-deload entry. Never done before: the plan, unchanged.
 */
export async function autoregulatedTargets(db: Db, date: string, workoutId: number, slots: WorkoutSlot[]): Promise<(SetTargets | null)[][]> {
  const planOnly = slots.map((wx) => wx.sets.map(() => null));
  const last = await get(db, `SELECT MAX(date) AS d FROM log_exercise WHERE workout_id = ? AND date < ? AND ${NOT_DELOAD}`, [workoutId, date]);
  if (!last?.d) return planOnly;
  const previous = await db.all(
    "SELECT id, exercise_id FROM log_exercise WHERE workout_id = ? AND date = ? ORDER BY position", [workoutId, last.d],
  );
  const used = new Set<number>();
  const result: (SetTargets | null)[][] = [];
  for (const wx of slots) {
    let entry = previous.find((p) => p.exercise_id === wx.exercise.id && !used.has(p.id));
    if (entry) used.add(entry.id);
    else {
      entry = await get(
        db, `SELECT id FROM log_exercise WHERE exercise_id = ? AND date < ? AND ${NOT_DELOAD} ORDER BY date DESC, position DESC LIMIT 1`,
        [wx.exercise.id, date],
      );
    }
    const prevSets = entry ? await db.all("SELECT * FROM log_set WHERE log_exercise_id = ? ORDER BY position", [entry.id]) : [];
    result.push(wx.sets.map((ws, n) => {
      const prev = prevSets[n];
      if (!prev || !wx.exercise.tracks.reps) return null;
      return nextTargets(prev as PreviousSet, ws, wx.exercise.tracks.weight);
    }));
  }
  return result;
}
