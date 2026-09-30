// The on-device schema, versioned with SQLite's PRAGMA user_version. Version 1 mirrors the
// Flask database at Alembic head 0005 column-for-column (so backups transfer one-to-one),
// plus what a fresh schema allows: ON DELETE CASCADE / SET NULL instead of Python-side
// cascades, and >= 0 checks on the target columns. Never edit a shipped migration; append.
import type { Db } from "./types";

export const MIGRATIONS: string[] = [
  // 1: initial schema (Flask/Alembic 0005)
  `
  CREATE TABLE muscle_group (
    id INTEGER PRIMARY KEY,
    name VARCHAR(50) COLLATE NOCASE NOT NULL UNIQUE
  );
  CREATE TABLE exercise (
    id INTEGER PRIMARY KEY,
    name VARCHAR(100) COLLATE NOCASE NOT NULL UNIQUE,
    tracks_weight BOOLEAN NOT NULL DEFAULT 0,
    tracks_reps BOOLEAN NOT NULL DEFAULT 0,
    tracks_time BOOLEAN NOT NULL DEFAULT 0,
    tracks_distance BOOLEAN NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    note TEXT
  );
  CREATE TABLE exercise_muscle (
    exercise_id INTEGER NOT NULL REFERENCES exercise (id) ON DELETE CASCADE,
    muscle_group_id INTEGER NOT NULL REFERENCES muscle_group (id),
    role VARCHAR(10) NOT NULL CHECK (role IN ('primary', 'ancillary')),
    PRIMARY KEY (exercise_id, muscle_group_id)
  );
  CREATE TABLE workout (
    id INTEGER PRIMARY KEY,
    name VARCHAR(100) COLLATE NOCASE NOT NULL UNIQUE,
    created_at DATETIME NOT NULL
  );
  CREATE TABLE workout_exercise (
    id INTEGER PRIMARY KEY,
    workout_id INTEGER NOT NULL REFERENCES workout (id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercise (id),
    position INTEGER NOT NULL,
    superset_group INTEGER,
    UNIQUE (workout_id, position)
  );
  CREATE TABLE workout_set (
    id INTEGER PRIMARY KEY,
    workout_exercise_id INTEGER NOT NULL REFERENCES workout_exercise (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    reps_min INTEGER CHECK (reps_min IS NULL OR reps_min >= 1),
    reps_max INTEGER,
    is_amrap BOOLEAN NOT NULL DEFAULT 0,
    weight FLOAT CHECK (weight IS NULL OR weight >= 0),
    duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    distance FLOAT CHECK (distance IS NULL OR distance >= 0),
    UNIQUE (workout_exercise_id, position),
    CHECK (NOT is_amrap OR (reps_min IS NULL AND reps_max IS NULL)),
    CHECK (reps_min IS NULL OR reps_max IS NULL OR reps_min <= reps_max)
  );
  CREATE TABLE routine (
    id INTEGER PRIMARY KEY,
    name VARCHAR(100) COLLATE NOCASE NOT NULL UNIQUE,
    created_at DATETIME NOT NULL,
    cycle_days INTEGER NOT NULL DEFAULT 7
  );
  CREATE TABLE routine_workout (
    id INTEGER PRIMARY KEY,
    routine_id INTEGER NOT NULL REFERENCES routine (id) ON DELETE CASCADE,
    workout_id INTEGER NOT NULL REFERENCES workout (id),
    position INTEGER NOT NULL,
    UNIQUE (routine_id, position)
  );
  CREATE TABLE routine_muscle_target (
    routine_id INTEGER NOT NULL REFERENCES routine (id) ON DELETE CASCADE,
    muscle_group_id INTEGER NOT NULL REFERENCES muscle_group (id),
    sets FLOAT CHECK (sets IS NULL OR sets >= 0),
    PRIMARY KEY (routine_id, muscle_group_id)
  );
  CREATE TABLE target_preset (
    id INTEGER PRIMARY KEY,
    name VARCHAR(100) COLLATE NOCASE NOT NULL UNIQUE,
    created_at DATETIME NOT NULL
  );
  CREATE TABLE target_preset_value (
    preset_id INTEGER NOT NULL REFERENCES target_preset (id) ON DELETE CASCADE,
    muscle_group_id INTEGER NOT NULL REFERENCES muscle_group (id),
    sets FLOAT NOT NULL CHECK (sets >= 0),
    PRIMARY KEY (preset_id, muscle_group_id)
  );
  CREATE TABLE log_exercise (
    id INTEGER PRIMARY KEY,
    date DATE NOT NULL,
    position INTEGER NOT NULL,
    exercise_id INTEGER NOT NULL REFERENCES exercise (id),
    workout_id INTEGER REFERENCES workout (id) ON DELETE SET NULL,
    superset_group INTEGER,
    note TEXT,
    UNIQUE (date, position)
  );
  CREATE INDEX ix_log_exercise_date ON log_exercise (date);
  CREATE INDEX ix_log_exercise_exercise ON log_exercise (exercise_id);
  CREATE TABLE log_set (
    id INTEGER PRIMARY KEY,
    log_exercise_id INTEGER NOT NULL REFERENCES log_exercise (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    target_reps_min INTEGER,
    target_reps_max INTEGER,
    target_amrap BOOLEAN NOT NULL DEFAULT 0,
    target_weight FLOAT CHECK (target_weight IS NULL OR target_weight >= 0),
    target_duration_seconds INTEGER CHECK (target_duration_seconds IS NULL OR target_duration_seconds >= 0),
    target_distance FLOAT CHECK (target_distance IS NULL OR target_distance >= 0),
    weight FLOAT CHECK (weight IS NULL OR weight >= 0),
    reps INTEGER CHECK (reps IS NULL OR reps >= 0),
    duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    distance FLOAT CHECK (distance IS NULL OR distance >= 0),
    completed_at DATETIME,
    UNIQUE (log_exercise_id, position)
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Brings the database up to SCHEMA_VERSION. Returns the version it started at. */
export async function migrate(db: Db): Promise<number> {
  const start = Number((await db.all("PRAGMA user_version"))[0].user_version);
  if (start > SCHEMA_VERSION) {
    throw new Error(`This database is from a newer version of FitApp (schema ${start}). Update the app.`);
  }
  for (let v = start; v < SCHEMA_VERSION; v++) {
    await db.transaction(async () => {
      await db.exec(MIGRATIONS[v]);
      await db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return start;
}

/** Tables in foreign-key order (parents first): the insert order for restoring a backup. */
export const TABLES = [
  "muscle_group", "exercise", "exercise_muscle", "workout", "workout_exercise", "workout_set",
  "routine", "routine_workout", "routine_muscle_target", "target_preset", "target_preset_value",
  "log_exercise", "log_set",
] as const;
