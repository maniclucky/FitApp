// Progress: daily volume and sets per muscle group over a date range. Ported from app.py.
import type { Db } from "../db/types";
import { orderedMuscleGroups } from "./muscles";
import { addDays, daysBetween, monthBefore, MUSCLE_SET_WEIGHTS, type MuscleRole, parseIsoDate, round2 } from "./text";

export const PROGRESS_MAX_DAYS = 366;

/** Validated range from optional start/end strings. Defaults to the past month, ending today. */
export function progressRange(start: string | null, end: string | null, today: string): { start: string; end: string; error: string | null } {
  const e = end ? end : today;
  const s = start ? start : parseIsoDate(e) ? monthBefore(e) : "";
  if (!parseIsoDate(e) || !parseIsoDate(s)) return { start: monthBefore(today), end: today, error: "Dates should look like 2026-09-30." };
  if (s > e) return { start: s, end: e, error: "The start date is after the end date." };
  if (daysBetween(s, e) + 1 > PROGRESS_MAX_DAYS) return { start: s, end: e, error: `Pick a range of at most ${PROGRESS_MAX_DAYS} days.` };
  return { start: s, end: e, error: null };
}

export interface ProgressData {
  nDays: number;
  days: { date: string; volume: number }[];
  muscles: { name: string; total: number; per_week: number }[];
  totalVolume: number;
  trainingDays: number;
  completedSets: number;
}

/**
 * Only completed sets count. Volume = sum of weight × reps per day. Muscle sets use the routine
 * weighting (primary 1, ancillary 0.5) with each exercise's current muscles; per week =
 * total × 7 / days in range.
 */
export async function progressData(db: Db, start: string, end: string): Promise<ProgressData> {
  const nDays = daysBetween(start, end) + 1;
  const volumeRows = await db.all(
    `SELECT lx.date, SUM(ls.weight * ls.reps) AS volume FROM log_exercise lx JOIN log_set ls ON ls.log_exercise_id = lx.id
     WHERE lx.date >= ? AND lx.date <= ? AND ls.completed_at IS NOT NULL AND ls.weight IS NOT NULL AND ls.reps IS NOT NULL
     GROUP BY lx.date`,
    [start, end],
  );
  const volumeByDay = new Map(volumeRows.map((r) => [r.date as string, r.volume as number]));
  const days = Array.from({ length: nDays }, (_, i) => {
    const date = addDays(start, i);
    return { date, volume: round2(volumeByDay.get(date) || 0) };
  });

  const setRows = await db.all(
    `SELECT lx.exercise_id, COUNT(ls.id) AS n FROM log_exercise lx JOIN log_set ls ON ls.log_exercise_id = lx.id
     WHERE lx.date >= ? AND lx.date <= ? AND ls.completed_at IS NOT NULL GROUP BY lx.exercise_id`,
    [start, end],
  );
  const setsByExercise = new Map(setRows.map((r) => [r.exercise_id as number, r.n as number]));
  const muscleSets = new Map<number, number>(); // muscle_group_id -> weighted sets
  for (const link of await db.all("SELECT exercise_id, muscle_group_id, role FROM exercise_muscle")) {
    const n = setsByExercise.get(link.exercise_id);
    if (n === undefined) continue;
    const role = link.role as MuscleRole;
    muscleSets.set(link.muscle_group_id, (muscleSets.get(link.muscle_group_id) ?? 0) + n * MUSCLE_SET_WEIGHTS[role]);
  }
  const muscles = (await orderedMuscleGroups(db)).map((mg) => {
    const total = muscleSets.get(mg.id) ?? 0;
    return { name: mg.name, total, per_week: (total * 7) / nDays };
  });
  return {
    nDays, days, muscles,
    totalVolume: days.reduce((sum, d) => sum + d.volume, 0),
    trainingDays: days.filter((d) => d.volume).length,
    completedSets: [...setsByExercise.values()].reduce((a, b) => a + b, 0),
  };
}

/** The quick range buttons: [label, start] ending today. */
export function rangePresets(today: string): [string, string][] {
  return [["Week", addDays(today, -6)], ["Month", monthBefore(today)], ["3 months", monthBefore(monthBefore(monthBefore(today)))]];
}
