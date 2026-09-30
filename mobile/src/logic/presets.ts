// Target presets: named weekly minimum sets per muscle group, applied in routine volume
// planning. A muscle group with no value counts as 0. Ported from app.py.
import { type Db, get, utcNow } from "../db/types";
import { NotFoundError } from "./errors";
import { orderedMuscleGroups } from "./muscles";
import { cleanName, formatNumber, parseLogValue, ValidationError } from "./text";

export interface Preset {
  id: number;
  name: string;
  /** muscle_group_id -> sets */
  sets: Map<number, number>;
}

export async function listPresets(db: Db, ids?: number[]): Promise<Preset[]> {
  const where = ids ? `WHERE id IN (${ids.map(() => "?").join(",") || "NULL"})` : "";
  const presets = await db.all(`SELECT id, name FROM target_preset ${where} ORDER BY name`, ids ?? []);
  const values = await db.all("SELECT preset_id, muscle_group_id, sets FROM target_preset_value");
  return presets.map((p) => ({
    id: p.id, name: p.name,
    sets: new Map(values.filter((v) => v.preset_id === p.id).map((v) => [v.muscle_group_id, v.sets])),
  }));
}

export async function getPreset(db: Db, id: number): Promise<Preset> {
  const [preset] = await listPresets(db, [id]);
  if (!preset) throw new NotFoundError("That preset no longer exists.");
  return preset;
}

export const presetTexts = (preset: Preset | null): Record<number, string> =>
  Object.fromEntries([...(preset?.sets ?? new Map())].map(([k, v]) => [k, formatNumber(v)]));

export type SavePresetResult =
  | { ok: true; id: number; name: string }
  | { ok: false; errors: string[]; bad: Set<number>; name: string; values: Record<number, string> };

/** Create (id null) or replace a preset. Blank values mean 0; every muscle group gets a row. */
export async function savePreset(db: Db, id: number | null, rawName: string, input: Record<number, string>): Promise<SavePresetResult> {
  if (id !== null) await getPreset(db, id);
  const name = cleanName(rawName ?? "", 100);
  const errors: string[] = [];
  const duplicate = await get(db, "SELECT id FROM target_preset WHERE name = ? AND id IS NOT ?", [name, id]);
  if (!name) errors.push("Name is required.");
  else if (duplicate) errors.push(`A preset named “${name}” already exists.`);
  const bad = new Set<number>();
  const values: Record<number, string> = {};
  const parsed = new Map<number, number>();
  for (const mg of await orderedMuscleGroups(db)) {
    const raw = (input?.[mg.id] ?? "").trim();
    values[mg.id] = raw;
    try {
      parsed.set(mg.id, parseLogValue(raw, `${mg.name} minimum`, { integer: false, maximum: 999 }) || 0);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      errors.push(e.message);
      bad.add(mg.id);
    }
  }
  if (errors.length) return { ok: false, errors, bad, name, values };

  const savedId = await db.transaction(async () => {
    let presetId = id;
    if (presetId === null) {
      presetId = (await db.run("INSERT INTO target_preset (name, created_at) VALUES (?, ?)", [name, utcNow()])).lastId;
    } else {
      await db.run("UPDATE target_preset SET name = ? WHERE id = ?", [name, presetId]);
      await db.run("DELETE FROM target_preset_value WHERE preset_id = ?", [presetId]);
    }
    for (const [muscleId, sets] of parsed) {
      await db.run("INSERT INTO target_preset_value (preset_id, muscle_group_id, sets) VALUES (?, ?, ?)", [presetId, muscleId, sets]);
    }
    return presetId;
  });
  return { ok: true, id: savedId, name };
}

export async function deletePreset(db: Db, id: number): Promise<string> {
  const preset = await getPreset(db, id);
  await db.run("DELETE FROM target_preset WHERE id = ?", [id]);
  return preset.name;
}

// The user's presets from defaultOptions.ods, so a fresh install (e.g. a friend's phone)
// starts with them. Keys are muscle group names; unlisted groups are 0.
export const DEFAULT_PRESETS: Record<string, Record<string, number>> = {
  Maintenance: {
    "Upper Back": 2, "Lower Back": 2, Calves: 2, Glutes: 2, Chest: 2, Biceps: 6, Quads: 2, "Side Deltoid": 2,
  },
  Minimum: {
    "Upper Back": 6, "Lower Back": 6, Triceps: 4, Calves: 4, Glutes: 6, Chest: 4, Biceps: 8, Quads: 4,
    Hamstrings: 2, "Side Deltoid": 6,
  },
};

/** Adds DEFAULT_PRESETS (every muscle group, missing = 0) unless presets with those names exist. */
export async function seedDefaultPresets(db: Db): Promise<void> {
  const muscles = await orderedMuscleGroups(db);
  await db.transaction(async () => {
    for (const [name, minimums] of Object.entries(DEFAULT_PRESETS)) {
      if (await get(db, "SELECT 1 FROM target_preset WHERE name = ?", [name])) continue;
      const presetId = (await db.run("INSERT INTO target_preset (name, created_at) VALUES (?, ?)", [name, utcNow()])).lastId;
      for (const m of muscles) {
        await db.run("INSERT INTO target_preset_value (preset_id, muscle_group_id, sets) VALUES (?, ?, ?)", [presetId, m.id, minimums[m.name] ?? 0]);
      }
    }
  });
}
