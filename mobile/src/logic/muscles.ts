// Muscle groups: the canonical list, its display order, and startup sync. Ported from models.py.
import { type Db, get } from "../db/types";
import { isLower, titleCase } from "./text";

// Created at startup if missing. Display order follows this list (head to toe); custom
// groups come after, in the order they were created.
export const DEFAULT_MUSCLE_GROUPS = [
  "Chest", "Front Deltoid", "Side Deltoid", "Rear Deltoid", "Biceps", "Triceps", "Forearms",
  "Upper Back", "Lats", "Traps", "Lower Back", "Abs", "Obliques",
  "Glutes", "Hip Flexors", "Quads", "Hamstrings", "Adductors", "Abductors", "Calves",
];
// Former defaults, removed at startup once nothing references them ("Shoulders" was split
// into front/side/rear deltoid). If still in use they stay, shown as custom groups.
export const RETIRED_MUSCLE_GROUPS = ["Shoulders"];
const DEFAULT_ORDER = new Map(DEFAULT_MUSCLE_GROUPS.map((n, i) => [n.toLowerCase(), i]));

export interface MuscleGroup {
  id: number;
  name: string;
}

/** Defaults in DEFAULT_MUSCLE_GROUPS order, then custom groups by creation (id). */
export function compareMuscles(a: MuscleGroup, b: MuscleGroup): number {
  const rank = (m: MuscleGroup) => DEFAULT_ORDER.get(m.name.toLowerCase()) ?? DEFAULT_ORDER.size;
  return rank(a) - rank(b) || a.id - b.id;
}

export async function orderedMuscleGroups(db: Db): Promise<MuscleGroup[]> {
  const rows = (await db.all("SELECT id, name FROM muscle_group")) as MuscleGroup[];
  return rows.sort(compareMuscles);
}

/** Create missing default muscle groups and drop retired ones that nothing references. */
export async function syncMuscleGroups(db: Db): Promise<void> {
  await db.transaction(async () => {
    const existing = new Map(
      ((await db.all("SELECT id, name FROM muscle_group")) as MuscleGroup[]).map((m) => [m.name.toLowerCase(), m]),
    );
    for (const name of DEFAULT_MUSCLE_GROUPS) {
      if (!existing.has(name.toLowerCase())) await db.run("INSERT INTO muscle_group (name) VALUES (?)", [name]);
    }
    for (const name of RETIRED_MUSCLE_GROUPS) {
      const muscle = existing.get(name.toLowerCase());
      if (!muscle) continue;
      let inUse = false;
      for (const table of ["exercise_muscle", "routine_muscle_target", "target_preset_value", "progress_target"]) {
        if (await get(db, `SELECT 1 FROM ${table} WHERE muscle_group_id = ? LIMIT 1`, [muscle.id])) inUse = true;
      }
      if (!inUse) await db.run("DELETE FROM muscle_group WHERE id = ?", [muscle.id]);
    }
  });
}

/** The id of the muscle group with this name (case-insensitive), creating it if needed. */
export async function getOrCreateMuscle(db: Db, name: string): Promise<number> {
  const found = await get(db, "SELECT id FROM muscle_group WHERE name = ?", [name]);
  if (found) return found.id;
  const { lastId } = await db.run("INSERT INTO muscle_group (name) VALUES (?)", [isLower(name) ? titleCase(name) : name]);
  return lastId;
}
