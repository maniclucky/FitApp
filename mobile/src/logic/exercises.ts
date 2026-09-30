// Exercises: listing, the add/edit form, delete rules, and picker data. Ported from app.py.
import { type Db, get, utcNow } from "../db/types";
import { NotFoundError } from "./errors";
import { compareMuscles, getOrCreateMuscle, orderedMuscleGroups } from "./muscles";
import {
  cleanMuscles, cleanName, cleanNote, MUSCLE_ROLES, type MuscleRole, TRACKING_MODES, type TrackingMode, ValidationError,
} from "./text";

export interface Exercise {
  id: number;
  name: string;
  note: string | null;
  modes: TrackingMode[];
  primary: string[];
  ancillary: string[];
  tracks: Record<TrackingMode, boolean>;
}

/** Every exercise (by name), with tracking modes and muscle names in canonical order. */
export async function listExercises(db: Db, ids?: number[]): Promise<Exercise[]> {
  const where = ids ? `WHERE id IN (${ids.map(() => "?").join(",") || "NULL"})` : "";
  const rows = await db.all(`SELECT * FROM exercise ${where} ORDER BY name`, ids ?? []);
  const links = await db.all(
    `SELECT em.exercise_id, em.role, mg.id, mg.name FROM exercise_muscle em JOIN muscle_group mg ON mg.id = em.muscle_group_id`,
  );
  return rows.map((r) => {
    const tracks = Object.fromEntries(TRACKING_MODES.map((m) => [m, Boolean(r[`tracks_${m}`])])) as Record<TrackingMode, boolean>;
    const muscles = (role: MuscleRole) =>
      links.filter((l) => l.exercise_id === r.id && l.role === role)
        .map((l) => ({ id: l.id as number, name: l.name as string }))
        .sort(compareMuscles)
        .map((m) => m.name);
    return {
      id: r.id, name: r.name, note: r.note, tracks,
      modes: TRACKING_MODES.filter((m) => tracks[m]),
      primary: muscles("primary"), ancillary: muscles("ancillary"),
    };
  });
}

export async function getExercise(db: Db, id: number): Promise<Exercise> {
  const [exercise] = await listExercises(db, [id]);
  if (!exercise) throw new NotFoundError("That exercise no longer exists.");
  return exercise;
}

/** Why an exercise can't be deleted (it's in a workout or has logged history), or null. */
export async function exerciseDeleteBlocker(db: Db, id: number): Promise<string | null> {
  const names = [...new Set((await db.all(
    "SELECT w.name FROM workout w JOIN workout_exercise wx ON wx.workout_id = w.id WHERE wx.exercise_id = ?", [id],
  )).map((r) => r.name as string))].sort();
  const days = (await get(db, "SELECT COUNT(DISTINCT date) AS n FROM log_exercise WHERE exercise_id = ?", [id]))!.n as number;
  const reasons: string[] = [];
  if (names.length) reasons.push(`used in ${names.join(", ")}`);
  if (days) reasons.push(`logged on ${days} day${days === 1 ? "" : "s"}`);
  if (!reasons.length) return null;
  const where = [
    ...(names.length ? [names.length > 1 ? "those workouts" : "that workout"] : []),
    ...(days ? [days > 1 ? "those days" : "that day"] : []),
  ].join(" and ");
  return `It’s ${reasons.join(" and ")}. Remove it from ${where} first.`;
}

export interface ExerciseForm {
  name: string;
  tracking: string[];
  primary: string[];
  ancillary: string[];
  note: string;
}

export type SaveResult = { ok: true; id: number; name: string } | { ok: false; errors: string[]; form: ExerciseForm };

/** Create (id null) or update an exercise. On errors nothing is saved and the normalized form is returned. */
export async function saveExercise(db: Db, id: number | null, input: ExerciseForm): Promise<SaveResult> {
  if (id !== null) await getExercise(db, id); // 404 if gone
  const form: ExerciseForm = {
    name: cleanName(input.name ?? "", 100),
    // Submitted order, unknown modes dropped (like Flask's getlist filter).
    tracking: (input.tracking ?? []).filter((m): m is TrackingMode => (TRACKING_MODES as readonly string[]).includes(m)),
    primary: cleanMuscles(input.primary ?? []),
    ancillary: [],
    note: input.note ?? "",
  };
  const primaryLower = new Set(form.primary.map((m) => m.toLowerCase()));
  form.ancillary = cleanMuscles(input.ancillary ?? []).filter((m) => !primaryLower.has(m.toLowerCase()));

  const errors: string[] = [];
  const duplicate = await get(db, "SELECT id FROM exercise WHERE name = ? AND id IS NOT ?", [form.name, id]);
  if (!form.name) errors.push("Name is required.");
  else if (duplicate) errors.push(`An exercise named “${form.name}” already exists.`);
  if (!form.tracking.length) errors.push("Pick at least one tracking mode.");
  if (!form.primary.length) errors.push("Pick at least one primary muscle group.");
  let note: string | null = null;
  try {
    note = cleanNote(form.note, "The note");
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    errors.push(e.message);
  }
  if (errors.length) return { ok: false, errors, form };

  const tracks = Object.fromEntries(TRACKING_MODES.map((m) => [m, form.tracking.includes(m) ? 1 : 0]));
  const savedId = await db.transaction(async () => {
    let exerciseId = id;
    if (exerciseId === null) {
      exerciseId = (await db.run(
        `INSERT INTO exercise (name, note, tracks_weight, tracks_reps, tracks_time, tracks_distance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [form.name, note, tracks.weight, tracks.reps, tracks.time, tracks.distance, utcNow()],
      )).lastId;
    } else {
      await db.run("DELETE FROM exercise_muscle WHERE exercise_id = ?", [exerciseId]);
      await db.run(
        `UPDATE exercise SET name = ?, note = ?, tracks_weight = ?, tracks_reps = ?, tracks_time = ?, tracks_distance = ?
         WHERE id = ?`,
        [form.name, note, tracks.weight, tracks.reps, tracks.time, tracks.distance, exerciseId],
      );
      // Targets for a mode the exercise no longer tracks are meaningless; clear them from workouts.
      const stale: string[] = [];
      if (!tracks.reps) stale.push("reps_min = NULL", "reps_max = NULL", "is_amrap = 0");
      if (!tracks.weight) stale.push("weight = NULL");
      if (!tracks.time) stale.push("duration_seconds = NULL");
      if (!tracks.distance) stale.push("distance = NULL");
      if (stale.length) {
        await db.run(
          `UPDATE workout_set SET ${stale.join(", ")}
           WHERE workout_exercise_id IN (SELECT id FROM workout_exercise WHERE exercise_id = ?)`,
          [exerciseId],
        );
      }
    }
    for (const role of MUSCLE_ROLES) {
      for (const name of form[role]) {
        const muscleId = await getOrCreateMuscle(db, name);
        await db.run("INSERT INTO exercise_muscle (exercise_id, muscle_group_id, role) VALUES (?, ?, ?)", [exerciseId, muscleId, role]);
      }
    }
    return exerciseId;
  });
  return { ok: true, id: savedId, name: form.name };
}

/** Deletes an exercise unless something uses it; returns its name. Throws ValidationError with the reason. */
export async function deleteExercise(db: Db, id: number): Promise<string> {
  const exercise = await getExercise(db, id);
  const blocker = await exerciseDeleteBlocker(db, id);
  if (blocker) throw new ValidationError(`Can’t delete “${exercise.name}”. ${blocker}`);
  await db.run("DELETE FROM exercise WHERE id = ?", [id]);
  return exercise.name;
}

/** Muscle names for the editor's chips: known groups in order, plus custom ones from `extra`. */
export async function muscleChoices(db: Db, extra: string[] = []): Promise<string[]> {
  const muscles = (await orderedMuscleGroups(db)).map((m) => m.name);
  const known = new Set(muscles.map((m) => m.toLowerCase()));
  for (const name of extra) {
    if (!known.has(name.toLowerCase())) {
      known.add(name.toLowerCase());
      muscles.push(name);
    }
  }
  return muscles;
}

export interface PickerOption {
  id: number;
  name: string;
  modes: TrackingMode[];
  primary: string[];
  ancillary: string[];
}

/** Options for an exercise picker, plus the muscles any of them use (canonical order), for filtering. */
export async function exercisePickerData(db: Db): Promise<{ options: PickerOption[]; muscles: string[] }> {
  const options = (await listExercises(db)).map(({ id, name, modes, primary, ancillary }) => ({ id, name, modes, primary, ancillary }));
  const used = new Set(options.flatMap((o) => [...o.primary, ...o.ancillary]).map((m) => m.toLowerCase()));
  const muscles = (await orderedMuscleGroups(db)).map((m) => m.name).filter((m) => used.has(m.toLowerCase()));
  return { options, muscles };
}
