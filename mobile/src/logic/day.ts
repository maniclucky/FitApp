// The day log: exercises and sets on a calendar day, loading workouts/routines, set
// autosave, notes, reordering, and calendar counts. Ported from app.py.
import { type Db, get, type Row, utcNow } from "../db/types";
import { autoregulatedTargets, nextTargets, NOT_DELOAD, type PreviousSet, type SetTargets } from "./autoregulation";
import { ConflictError, NotFoundError } from "./errors";
import { type Exercise, listExercises } from "./exercises";
import { getRoutine, routineNextIndex } from "./routines";
import { cleanNote, parseIsoDate, parseLogValue, pyTruthy, repTargetLabel, ValidationError } from "./text";
import { getWorkout, groupBlocks, type Item, type Workout } from "./workouts";

export interface LogSet {
  id: number;
  position: number;
  target_reps_min: number | null;
  target_reps_max: number | null;
  target_amrap: boolean;
  /** The single rep target autoregulation set (null when it didn't). */
  target_reps: number | null;
  target_weight: number | null;
  target_duration_seconds: number | null;
  target_distance: number | null;
  weight: number | null;
  reps: number | null;
  duration_seconds: number | null;
  distance: number | null;
  completed_at: string | null;
  /** Rep target in brief ("11", "8–12", "AMRAP", ""), for the reps field's placeholder. */
  target_label: string;
}

export interface LogEntry {
  id: number;
  date: string;
  position: number;
  superset_group: number | null;
  note: string | null;
  exercise: Exercise;
  workout_id: number | null;
  workout_name: string | null;
  sets: LogSet[];
}

export function toLogSet(r: Row): LogSet {
  return {
    id: r.id, position: r.position,
    target_reps_min: r.target_reps_min, target_reps_max: r.target_reps_max, target_amrap: Boolean(r.target_amrap),
    target_reps: r.target_reps ?? null, target_weight: r.target_weight, target_duration_seconds: r.target_duration_seconds, target_distance: r.target_distance,
    weight: r.weight, reps: r.reps, duration_seconds: r.duration_seconds, distance: r.distance, completed_at: r.completed_at,
    target_label: r.target_reps != null ? String(r.target_reps) : repTargetLabel(r.target_reps_min, r.target_reps_max, Boolean(r.target_amrap)),
  };
}

/** What the set autosave returns (the Flask API's LogSet.to_dict()). */
export const setState = (s: LogSet) => ({
  id: s.id, weight: s.weight, reps: s.reps, duration_seconds: s.duration_seconds, distance: s.distance,
  completed: s.completed_at !== null,
});

export function checkDate(value: unknown): string {
  if (!parseIsoDate(value)) throw new NotFoundError("That isn’t a valid date.");
  return value as string;
}

/** Log entries matching `where` (e.g. one date), in order, with exercises and sets. */
export async function loadEntries(db: Db, where: string, params: unknown[]): Promise<LogEntry[]> {
  const rows = await db.all(
    `SELECT lx.*, w.name AS workout_name FROM log_exercise lx LEFT JOIN workout w ON w.id = lx.workout_id
     WHERE ${where} ORDER BY lx.date DESC, lx.position`, params,
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const sets = await db.all(
    `SELECT * FROM log_set WHERE log_exercise_id IN (${ids.map(() => "?").join(",")}) ORDER BY log_exercise_id, position`, ids,
  );
  const exercises = new Map((await listExercises(db, [...new Set(rows.map((r) => r.exercise_id as number))])).map((e) => [e.id, e]));
  return rows.map((r) => ({
    id: r.id, date: r.date, position: r.position, superset_group: r.superset_group, note: r.note,
    exercise: exercises.get(r.exercise_id)!, workout_id: r.workout_id, workout_name: r.workout_name,
    sets: sets.filter((s) => s.log_exercise_id === r.id).map(toLogSet),
  }));
}

export async function dayEntries(db: Db, date: string): Promise<LogEntry[]> {
  return loadEntries(db, "lx.date = ?", [checkDate(date)]);
}

async function getEntry(db: Db, id: number): Promise<LogEntry> {
  const [entry] = await loadEntries(db, "lx.id = ?", [id]);
  if (!entry) throw new NotFoundError("That exercise is no longer on this day.");
  return entry;
}

/**
 * Set ids whose completion should auto-start the rest timer. Outside a superset: every set.
 * In a superset, round n ends with the last member that has an nth set, so only that set counts.
 */
export function restAfterSets(blocks: LogEntry[][]): Set<number> {
  const ids = new Set<number>();
  for (const block of blocks) {
    for (const lx of block) {
      lx.sets.forEach((s, n) => {
        const members = block.filter((m) => m.sets.length > n);
        if (members.at(-1) === lx) ids.add(s.id);
      });
    }
  }
  return ids;
}

export const dayBlocks = (entries: LogEntry[]) => groupBlocks(entries);

/**
 * "Build workout from day" (user requirement): the day's exercises in order, with its supersets
 * and set counts, and every target blank (no rep range, AMRAP, weight, time or distance).
 */
export function dayToWorkoutItems(entries: LogEntry[]): Item[] {
  return entries.map((lx, i) => ({
    exercise_id: lx.exercise.id,
    superset_next: lx.superset_group !== null && entries[i + 1]?.superset_group === lx.superset_group,
    sets: lx.sets.map(() => ({ min: null, max: null, amrap: false, weight: null, time: null, distance: null })),
  }));
}

async function nextPositionAndGroup(db: Db, date: string): Promise<[number, number]> {
  const r = (await get(db, "SELECT MAX(position) AS p, MAX(superset_group) AS g FROM log_exercise WHERE date = ?", [date]))!;
  return [(r.p ?? 0) + 1, r.g ?? 0];
}

/**
 * Append a workout's exercises to a day, snapshotting its targets so later plan edits never change
 * history. `adjusted` (autoregulation) replaces the rep and weight targets of matching sets.
 */
export async function addWorkoutToDay(db: Db, date: string, workout: Workout, adjusted?: (SetTargets | null)[][]): Promise<void> {
  await db.transaction(async () => {
    let [position, lastGroup] = await nextPositionAndGroup(db, date);
    const groups = new Map<number, number>(); // workout superset_group -> day superset_group
    for (const [i, wx] of workout.slots.entries()) {
      let group: number | null = null;
      if (wx.superset_group !== null) {
        if (!groups.has(wx.superset_group)) groups.set(wx.superset_group, lastGroup + groups.size + 1);
        group = groups.get(wx.superset_group)!;
      }
      const entryId = (await db.run(
        "INSERT INTO log_exercise (date, position, exercise_id, workout_id, superset_group) VALUES (?, ?, ?, ?, ?)",
        [date, position, wx.exercise.id, workout.id, group],
      )).lastId;
      for (const [n, ws] of wx.sets.entries()) {
        const a = adjusted?.[i]?.[n];
        await db.run(
          `INSERT INTO log_set (log_exercise_id, position, target_reps_min, target_reps_max, target_amrap, target_reps,
             target_weight, target_duration_seconds, target_distance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [entryId, n + 1, ws.reps_min, ws.reps_max, ws.is_amrap ? 1 : 0, a ? a.reps : null, a ? a.weight : ws.weight,
            ws.duration_seconds, ws.distance],
        );
      }
      position++;
    }
  });
}

// `autoregulate` is the Settings switch (user requirement, 2026-10-10; per device, so the UI
// passes it in). Off: plan targets as saved, like Flask.

/** Loads a workout. Autoregulated from that workout's latest earlier non-deload session, from any source. */
export async function loadWorkout(db: Db, date: string, workoutId: number, autoregulate = false): Promise<void> {
  checkDate(date);
  const workout = await getWorkout(db, workoutId);
  const adjusted = autoregulate ? await autoregulatedTargets(db, date, workout.id, workout.slots) : undefined;
  await addWorkoutToDay(db, date, workout, adjusted);
}

/** Loads the routine's workout at `index` (default: the next one in its rotation). Returns the workout name. */
export async function loadRoutine(db: Db, date: string, routineId: number, index?: number, autoregulate = false): Promise<string> {
  checkDate(date);
  const routine = await getRoutine(db, routineId);
  if (!routine.workout_ids.length) throw new ConflictError("That routine has no workouts.");
  const i = index ?? (await routineNextIndex(db, routine, date));
  if (!(Number.isInteger(i) && i >= 0 && i < routine.workout_ids.length)) {
    throw new ConflictError("That routine changed. Reload and try again.");
  }
  const workout = await getWorkout(db, routine.workout_ids[i]);
  const adjusted = autoregulate ? await autoregulatedTargets(db, date, workout.id, workout.slots) : undefined;
  await addWorkoutToDay(db, date, workout, adjusted);
  return workout.name;
}

/**
 * Appends exercises to a day in the given order: 3 empty sets each, or 1 if it doesn't track reps.
 * Autoregulated: each one's targets come from that exercise's last session, as with the AR button.
 */
export async function addExercises(db: Db, date: string, ids: unknown, autoregulate = false): Promise<void> {
  checkDate(date);
  if (!Array.isArray(ids) || !ids.length || ids.some((i) => typeof i !== "number" || !Number.isInteger(i))) {
    throw new ValidationError("Pick at least one exercise.");
  }
  const byId = new Map((await listExercises(db, [...new Set(ids as number[])])).map((e) => [e.id, e]));
  if (byId.size !== new Set(ids).size) throw new NotFoundError("One of the selected exercises no longer exists.");
  await db.transaction(async () => {
    const [position] = await nextPositionAndGroup(db, date);
    for (const [offset, exerciseId] of (ids as number[]).entries()) {
      const entryId = (await db.run(
        "INSERT INTO log_exercise (date, position, exercise_id) VALUES (?, ?, ?)", [date, position + offset, exerciseId],
      )).lastId;
      const count = byId.get(exerciseId)!.tracks.reps ? 3 : 1;
      for (let n = 1; n <= count; n++) await db.run("INSERT INTO log_set (log_exercise_id, position) VALUES (?, ?)", [entryId, n]);
      if (autoregulate && byId.get(exerciseId)!.tracks.reps) await targetsFromLastSession(db, entryId);
    }
  });
}

/** Reorders a day's exercises: every entry id on that day, in the new order. Supersets must stay together. */
export async function reorderDay(db: Db, date: string, ids: unknown): Promise<void> {
  checkDate(date);
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "number" || !Number.isInteger(i))) {
    throw new ValidationError("Couldn’t read the new order.");
  }
  const entries = new Map((await db.all("SELECT id, superset_group FROM log_exercise WHERE date = ?", [date])).map((r) => [r.id, r]));
  const unique = new Set(ids);
  if (unique.size !== ids.length || unique.size !== entries.size || ids.some((i) => !entries.has(i))) {
    throw new ConflictError("This day changed. Reload and try again.");
  }
  const seen = new Set<number | null>();
  let prev: number | null | undefined;
  for (const i of ids as number[]) {
    const group = entries.get(i)!.superset_group;
    if (group !== null && group !== prev && seen.has(group)) throw new ValidationError("A superset can’t be split up.");
    seen.add(group);
    prev = group;
  }
  await db.transaction(async () => {
    // Park on negative positions first so the (date, position) unique key never collides.
    for (const [n, i] of (ids as number[]).entries()) await db.run("UPDATE log_exercise SET position = ? WHERE id = ?", [-(n + 1), i]);
    for (const [n, i] of (ids as number[]).entries()) await db.run("UPDATE log_exercise SET position = ? WHERE id = ?", [n + 1, i]);
  });
}

/**
 * The day view's superset button (user requirement): link an exercise with the one below it into
 * a superset (joining either one's existing superset), or unlink them, which splits the superset
 * there. A superset left with one exercise stops being one.
 */
export async function setSupersetWithNext(db: Db, entryId: number, link: boolean): Promise<void> {
  const entry = await get(db, "SELECT date FROM log_exercise WHERE id = ?", [entryId]);
  if (!entry) throw new NotFoundError("That exercise is no longer on this day.");
  const rows = await db.all("SELECT id, superset_group FROM log_exercise WHERE date = ? ORDER BY position", [entry.date]);
  const i = rows.findIndex((r) => r.id === entryId);
  if (i === rows.length - 1) throw new ValidationError("There’s no exercise below to superset with.");
  const groups: (number | null)[] = rows.map((r) => r.superset_group);
  const fresh = Math.max(0, ...groups.map((g) => g ?? 0)) + 1;
  const linked = groups[i] !== null && groups[i] === groups[i + 1];
  if (link === linked) return;
  if (link) {
    const keep = groups[i] ?? groups[i + 1] ?? fresh;
    const merged = [groups[i], groups[i + 1]].filter((g) => g !== null && g !== keep);
    for (let k = 0; k < groups.length; k++) {
      if (k === i || k === i + 1 || (groups[k] !== null && merged.includes(groups[k]))) groups[k] = keep;
    }
  } else {
    const split = groups[i];
    for (let k = i + 1; k < groups.length && groups[k] === split; k++) groups[k] = fresh;
  }
  const size = new Map<number, number>();
  for (const g of groups) if (g !== null) size.set(g, (size.get(g) ?? 0) + 1);
  await db.transaction(async () => {
    for (const [k, r] of rows.entries()) {
      const g = groups[k] !== null && size.get(groups[k]!)! > 1 ? groups[k] : null;
      if (g !== r.superset_group) await db.run("UPDATE log_exercise SET superset_group = ? WHERE id = ?", [g, r.id]);
    }
  });
}

// Set autosave fields: column -> how to validate the value.
const LOG_FIELDS = {
  weight: { label: "Weight", integer: false, maximum: 10_000 },
  reps: { label: "Reps", integer: true, maximum: 9_999 },
  duration_seconds: { label: "Time", integer: true, maximum: 86_400 },
  distance: { label: "Distance", integer: false, maximum: 1_000 },
} as const;

async function getSet(db: Db, id: number): Promise<LogSet> {
  const row = await get(db, "SELECT * FROM log_set WHERE id = ?", [id]);
  if (!row) throw new NotFoundError("That set no longer exists.");
  return toLogSet(row);
}

/**
 * Autosave: any of weight/reps/duration_seconds/distance (blank clears), and/or completed.
 * All values are validated before anything is written. Returns the saved set state.
 */
export async function updateSet(db: Db, setId: number, data: Record<string, unknown>) {
  const current = await getSet(db, setId);
  const updates: [string, unknown][] = [];
  for (const [field, spec] of Object.entries(LOG_FIELDS)) {
    if (field in data) updates.push([field, parseLogValue(data[field], spec.label, spec)]);
  }
  if ("completed" in data) {
    updates.push(["completed_at", pyTruthy(data.completed) ? (current.completed_at ?? utcNow()) : null]);
  }
  if (updates.length) {
    await db.run(`UPDATE log_set SET ${updates.map(([f]) => `${f} = ?`).join(", ")} WHERE id = ?`, [...updates.map(([, v]) => v), setId]);
  }
  return setState(await getSet(db, setId));
}

/**
 * Exercise-based autoregulation, for the day card's AR button and for exercises added on their own
 * (user requirement, 2026-10-10): sets each set's rep and weight targets by the autoregulation
 * rules, from this exercise's latest non-deload entry before this day (any source, ad hoc or a
 * workout), matching sets by position. It replaces targets already there (e.g. from a workout's
 * autoregulation). The range is the set's own target range (8–15 when it has none). Sets past the
 * reference's count keep their targets. Completed sets are skipped, and so is each target whose
 * field already has a value (user requirement); logged values are never touched.
 * Returns the reference date, or null when there's no earlier entry to go by.
 */
export async function autoregulateEntry(db: Db, entryId: number): Promise<string | null> {
  return db.transaction(() => targetsFromLastSession(db, entryId));
}

async function targetsFromLastSession(db: Db, entryId: number): Promise<string | null> {
  const entry = await getEntry(db, entryId);
  if (!entry.exercise.tracks.reps) throw new ValidationError("Autoregulation needs an exercise that tracks reps.");
  const ref = await get(
    db, `SELECT id, date FROM log_exercise WHERE exercise_id = ? AND date < ? AND ${NOT_DELOAD} ORDER BY date DESC, position DESC LIMIT 1`,
    [entry.exercise.id, entry.date],
  );
  if (!ref) return null;
  const prevSets = await db.all("SELECT * FROM log_set WHERE log_exercise_id = ? ORDER BY position", [ref.id]);
  for (const [n, s] of entry.sets.entries()) {
    if (!prevSets[n]) break;
    if (s.completed_at !== null) continue;
    const plan = { reps_min: s.target_reps_min, reps_max: s.target_reps_max, is_amrap: s.target_amrap, weight: s.target_weight };
    const t = nextTargets(prevSets[n] as PreviousSet, plan, entry.exercise.tracks.weight);
    const updates: [string, number | null][] = [];
    if (s.reps === null) updates.push(["target_reps", t.reps]);
    if (s.weight === null) updates.push(["target_weight", t.weight]);
    if (updates.length) {
      await db.run(`UPDATE log_set SET ${updates.map(([f]) => `${f} = ?`).join(", ")} WHERE id = ?`, [...updates.map(([, v]) => v), s.id]);
    }
  }
  return ref.date;
}

/** Adds a set after the last one, copying its targets. */
export async function addLogSet(db: Db, entryId: number) {
  const entry = await getEntry(db, entryId);
  const last = entry.sets.at(-1);
  const { lastId } = await db.run(
    `INSERT INTO log_set (log_exercise_id, position, target_reps_min, target_reps_max, target_amrap, target_reps,
       target_weight, target_duration_seconds, target_distance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entryId, last ? last.position + 1 : 1, last?.target_reps_min ?? null, last?.target_reps_max ?? null,
      last?.target_amrap ? 1 : 0, last?.target_reps ?? null, last?.target_weight ?? null, last?.target_duration_seconds ?? null, last?.target_distance ?? null],
  );
  return setState(await getSet(db, lastId));
}

/** Removes the last set, unless it's the only one or it's completed. */
export async function removeLastLogSet(db: Db, entryId: number): Promise<void> {
  const entry = await getEntry(db, entryId);
  if (entry.sets.length <= 1) throw new ConflictError("An exercise needs at least one set. Remove the exercise instead.");
  const last = entry.sets.at(-1)!;
  if (last.completed_at !== null) throw new ConflictError("The last set is completed. Un-check it before removing it.");
  await db.run("DELETE FROM log_set WHERE id = ?", [last.id]);
}

/**
 * Sets the exercise's every-time note and/or this entry's session note (either key optional;
 * blank clears). Both are validated before either is saved.
 */
export async function updateNotes(db: Db, entryId: number, data: { exercise_note?: unknown; session_note?: unknown }) {
  const entry = await getEntry(db, entryId);
  const exerciseNote = "exercise_note" in data ? cleanNote(data.exercise_note, "The exercise note") : undefined;
  const sessionNote = "session_note" in data ? cleanNote(data.session_note, "The session note") : undefined;
  await db.transaction(async () => {
    if (exerciseNote !== undefined) await db.run("UPDATE exercise SET note = ? WHERE id = ?", [exerciseNote, entry.exercise.id]);
    if (sessionNote !== undefined) await db.run("UPDATE log_exercise SET note = ? WHERE id = ?", [sessionNote, entryId]);
  });
  return {
    exercise_note: exerciseNote !== undefined ? exerciseNote : entry.exercise.note,
    session_note: sessionNote !== undefined ? sessionNote : entry.note,
  };
}

/** Removes an exercise (and its sets) from its day. Returns the exercise name. */
export async function deleteLogEntry(db: Db, entryId: number): Promise<string> {
  const entry = await getEntry(db, entryId);
  await db.run("DELETE FROM log_exercise WHERE id = ?", [entryId]);
  return entry.exercise.name;
}

/** Removes everything on a day. Returns how many exercises were removed. */
export async function clearDay(db: Db, date: string): Promise<number> {
  checkDate(date);
  // Count first: "rows changed" from the plugin includes cascaded set deletes on some platforms.
  const n = (await get(db, "SELECT COUNT(*) AS n FROM log_exercise WHERE date = ?", [date]))!.n as number;
  await db.transaction(async () => {
    await db.run("DELETE FROM log_exercise WHERE date = ?", [date]);
    await db.run("DELETE FROM deload_day WHERE date = ?", [date]); // the deload mark goes too (user)
  });
  return n;
}

/** Per-day set counts for a month ("YYYY-MM"): {"YYYY-MM-DD": {sets, done}}. */
export async function calendarCounts(db: Db, month: string): Promise<Record<string, { sets: number; done: number }>> {
  const first = `${month}-01`;
  if (!parseIsoDate(first)) throw new ValidationError("That isn’t a valid month.");
  const [y, m] = month.split("-").map(Number);
  const after = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const rows = await db.all(
    `SELECT lx.date, COUNT(ls.id) AS sets, COUNT(ls.completed_at) AS done FROM log_exercise lx
     JOIN log_set ls ON ls.log_exercise_id = lx.id WHERE lx.date >= ? AND lx.date < ? GROUP BY lx.date`,
    [first, after],
  );
  return Object.fromEntries(rows.map((r) => [r.date, { sets: r.sets, done: r.done }]));
}
