from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

TRACKING_MODES = ["weight", "reps", "time", "distance"]
MUSCLE_ROLES = ["primary", "ancillary"]
NOTE_MAX_LENGTH = 500  # exercise notes and session notes
# How much one set counts toward a muscle's volume, by the muscle's role in the exercise.
MUSCLE_SET_WEIGHTS = {"primary": 1, "ancillary": 0.5}

# Created at startup if missing. Display order follows this list (head to toe); custom
# groups come after, in the order they were created.
DEFAULT_MUSCLE_GROUPS = [
    "Chest", "Front Deltoid", "Side Deltoid", "Rear Deltoid", "Biceps", "Triceps", "Forearms",
    "Upper Back", "Lats", "Traps", "Lower Back", "Abs", "Obliques",
    "Glutes", "Hip Flexors", "Quads", "Hamstrings", "Adductors", "Abductors", "Calves",
]
# Former defaults, removed at startup once nothing references them ("Shoulders" was split
# into front/side/rear deltoid). If still in use they stay, shown as custom groups.
RETIRED_MUSCLE_GROUPS = ["Shoulders"]
_DEFAULT_ORDER = {name.lower(): i for i, name in enumerate(DEFAULT_MUSCLE_GROUPS)}


def muscle_sort_key(muscle_group):
    """Defaults in DEFAULT_MUSCLE_GROUPS order, then custom groups by creation (id)."""
    return (_DEFAULT_ORDER.get(muscle_group.name.lower(), len(_DEFAULT_ORDER)), muscle_group.id)


def utcnow():
    return datetime.now(timezone.utc)


def group_blocks(slots):
    """Group ordered slots for display: consecutive slots sharing a superset_group form one block."""
    blocks = []
    for slot in slots:
        if blocks and slot.superset_group is not None and blocks[-1][-1].superset_group == slot.superset_group:
            blocks[-1].append(slot)
        else:
            blocks.append([slot])
    return blocks


def format_duration(seconds):
    """90 -> '1:30', None -> ''."""
    if seconds is None:
        return ""
    return f"{seconds // 60}:{seconds % 60:02d}"


def set_target_label(reps_min, reps_max, amrap, weight, seconds, distance):
    """A planned set in brief, e.g. '8–12 @ 135 lb', '50 lb · 0:45', '25:00 · 3 mi', or ''."""
    head = rep_target_label(reps_min, reps_max, amrap)
    if weight is not None:
        head = f"{head} @ {weight:g} lb" if head else f"{weight:g} lb"
    parts = [head, format_duration(seconds), f"{distance:g} mi" if distance is not None else ""]
    return " · ".join(p for p in parts if p)


def rep_target_label(lo, hi, amrap):
    """e.g. '8–12', '10', '8+', '≤12', 'AMRAP', or '' for no target."""
    if amrap:
        return "AMRAP"
    if lo and hi:
        return str(lo) if lo == hi else f"{lo}–{hi}"
    if lo:
        return f"{lo}+"
    if hi:
        return f"≤{hi}"
    return ""


class Exercise(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100, collation="NOCASE"), nullable=False, unique=True)
    tracks_weight = db.Column(db.Boolean, nullable=False, default=False)
    tracks_reps = db.Column(db.Boolean, nullable=False, default=False)
    tracks_time = db.Column(db.Boolean, nullable=False, default=False)
    tracks_distance = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    note = db.Column(db.Text)  # shown every time the exercise is used (NOTE_MAX_LENGTH)

    muscles = db.relationship(
        "ExerciseMuscle", back_populates="exercise", cascade="all, delete-orphan"
    )

    @property
    def tracking_modes(self):
        return [m for m in TRACKING_MODES if getattr(self, f"tracks_{m}")]

    def muscle_names(self, role):
        ordered = sorted(
            (em for em in self.muscles if em.role == role),
            key=lambda em: muscle_sort_key(em.muscle_group),
        )
        return [em.muscle_group.name for em in ordered]


class MuscleGroup(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50, collation="NOCASE"), nullable=False, unique=True)


class ExerciseMuscle(db.Model):
    """Links an exercise to a muscle group as either primary or ancillary."""

    exercise_id = db.Column(db.ForeignKey("exercise.id"), primary_key=True)
    muscle_group_id = db.Column(db.ForeignKey("muscle_group.id"), primary_key=True)
    role = db.Column(db.String(10), nullable=False)

    __table_args__ = (
        db.CheckConstraint("role IN ('primary', 'ancillary')", name="ck_exercise_muscle_role"),
    )

    exercise = db.relationship("Exercise", back_populates="muscles")
    muscle_group = db.relationship("MuscleGroup")


def ordered_muscle_groups():
    return sorted(db.session.scalars(db.select(MuscleGroup)).all(), key=muscle_sort_key)


def sync_muscle_groups():
    """Create missing default muscle groups and drop retired ones that nothing references."""
    existing = {m.name.lower(): m for m in db.session.scalars(db.select(MuscleGroup)).all()}
    db.session.add_all(MuscleGroup(name=n) for n in DEFAULT_MUSCLE_GROUPS if n.lower() not in existing)
    for name in RETIRED_MUSCLE_GROUPS:
        muscle = existing.get(name.lower())
        in_use = muscle is not None and any(
            db.session.query(model).filter_by(muscle_group_id=muscle.id).first() is not None
            for model in (ExerciseMuscle, RoutineMuscleTarget, TargetPresetValue)
        )
        if muscle is not None and not in_use:
            db.session.delete(muscle)
    db.session.commit()


class Workout(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100, collation="NOCASE"), nullable=False, unique=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    exercises = db.relationship(
        "WorkoutExercise",
        back_populates="workout",
        order_by="WorkoutExercise.position",
        cascade="all, delete-orphan",
    )

    @property
    def blocks(self):
        return group_blocks(self.exercises)


class WorkoutExercise(db.Model):
    """One exercise slot in a workout.

    Consecutive slots sharing a non-null superset_group (unique within the workout) form a superset.
    """

    id = db.Column(db.Integer, primary_key=True)
    workout_id = db.Column(db.ForeignKey("workout.id"), nullable=False)
    exercise_id = db.Column(db.ForeignKey("exercise.id"), nullable=False)
    position = db.Column(db.Integer, nullable=False)
    superset_group = db.Column(db.Integer)

    __table_args__ = (db.UniqueConstraint("workout_id", "position"),)

    workout = db.relationship("Workout", back_populates="exercises")
    exercise = db.relationship("Exercise")
    sets = db.relationship(
        "WorkoutSet",
        back_populates="workout_exercise",
        order_by="WorkoutSet.position",
        cascade="all, delete-orphan",
    )

    @property
    def summary(self):
        """e.g. '3 × 8–12 @ 135 lb', '3 sets: 10, 8, AMRAP', '1 × 25:00 · 3 mi', or '2 sets'."""
        n = len(self.sets)
        labels = [s.label for s in self.sets]
        if not any(labels):
            return f"{n} set" if n == 1 else f"{n} sets"
        if len(set(labels)) == 1:
            return f"{n} × {labels[0]}"
        # Sets differ; if they all share a weight, say it once at the end.
        weights = {s.weight for s in self.sets}
        suffix = ""
        if len(weights) == 1 and None not in weights:
            suffix = f" @ {weights.pop():g} lb"
            labels = [
                set_target_label(s.reps_min, s.reps_max, s.is_amrap, None, s.duration_seconds, s.distance)
                for s in self.sets
            ]
        return f"{n} sets: " + ", ".join(label or "—" for label in labels) + suffix


class WorkoutSet(db.Model):
    """A planned set. Every target is optional: a rep range (each bound optional; AMRAP sets have
    no bounds), weight (lb), time and distance (mi), used for whichever modes the exercise tracks.

    weight/duration_seconds/distance are validated as >= 0 by the app, not the DB: adding CHECKs
    would make SQLite rebuild the table (see agent-notes/data-model.md).
    """

    id = db.Column(db.Integer, primary_key=True)
    workout_exercise_id = db.Column(db.ForeignKey("workout_exercise.id"), nullable=False)
    position = db.Column(db.Integer, nullable=False)
    reps_min = db.Column(db.Integer)
    reps_max = db.Column(db.Integer)
    is_amrap = db.Column(db.Boolean, nullable=False, default=False)
    weight = db.Column(db.Float)
    duration_seconds = db.Column(db.Integer)
    distance = db.Column(db.Float)

    __table_args__ = (
        db.UniqueConstraint("workout_exercise_id", "position"),
        db.CheckConstraint(
            "NOT is_amrap OR (reps_min IS NULL AND reps_max IS NULL)", name="ck_workout_set_amrap"
        ),
        db.CheckConstraint(
            "reps_min IS NULL OR reps_max IS NULL OR reps_min <= reps_max", name="ck_workout_set_range"
        ),
        db.CheckConstraint("reps_min IS NULL OR reps_min >= 1", name="ck_workout_set_min"),
    )

    workout_exercise = db.relationship("WorkoutExercise", back_populates="sets")

    @property
    def label(self):
        return set_target_label(
            self.reps_min, self.reps_max, self.is_amrap, self.weight, self.duration_seconds, self.distance
        )


class Routine(db.Model):
    """A saved, ordered set of workouts (e.g. Push / Pull / Legs).

    cycle_days is how many days one pass through the routine takes; Volume Planning scales the
    routine's sets by 7 / cycle_days to show weekly volume. Validated as 1..365 by the app.
    """

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100, collation="NOCASE"), nullable=False, unique=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    cycle_days = db.Column(db.Integer, nullable=False, default=7, server_default="7")

    workouts = db.relationship(
        "RoutineWorkout",
        back_populates="routine",
        order_by="RoutineWorkout.position",
        cascade="all, delete-orphan",
    )
    targets = db.relationship("RoutineMuscleTarget", cascade="all, delete-orphan")


class RoutineWorkout(db.Model):
    """One workout slot in a routine. The same workout may appear more than once (A / B / A)."""

    id = db.Column(db.Integer, primary_key=True)
    routine_id = db.Column(db.ForeignKey("routine.id"), nullable=False)
    workout_id = db.Column(db.ForeignKey("workout.id"), nullable=False)
    position = db.Column(db.Integer, nullable=False)

    __table_args__ = (db.UniqueConstraint("routine_id", "position"),)

    routine = db.relationship("Routine", back_populates="workouts")
    workout = db.relationship("Workout")


class TargetPreset(db.Model):
    """A named set of weekly minimum sets per muscle group that the routine planner can apply.

    Imported from a spreadsheet (scripts/import_presets.py) or made in the app (/presets/new).
    A muscle group with no value row counts as 0.
    """

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100, collation="NOCASE"), nullable=False, unique=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    values = db.relationship("TargetPresetValue", cascade="all, delete-orphan")

    def sets_by_muscle_id(self):
        return {v.muscle_group_id: v.sets for v in self.values}


class TargetPresetValue(db.Model):
    preset_id = db.Column(db.ForeignKey("target_preset.id"), primary_key=True)
    muscle_group_id = db.Column(db.ForeignKey("muscle_group.id"), primary_key=True)
    sets = db.Column(db.Float, nullable=False)

    __table_args__ = (db.CheckConstraint("sets >= 0", name="ck_target_preset_value_sets"),)


class RoutineMuscleTarget(db.Model):
    """How many sets per pass through the routine the user wants for a muscle group.

    Saving a routine writes a row for every muscle group; sets is NULL when the user left it
    blank. Targets are weekly minimums; presets (TargetPreset) fill them in the planner.
    """

    routine_id = db.Column(db.ForeignKey("routine.id"), primary_key=True)
    muscle_group_id = db.Column(db.ForeignKey("muscle_group.id"), primary_key=True)
    sets = db.Column(db.Float)

    __table_args__ = (db.CheckConstraint("sets IS NULL OR sets >= 0", name="ck_routine_muscle_target_sets"),)


class LogExercise(db.Model):
    """An exercise performed (or planned) on a calendar day.

    Loading a workout copies its slots here; the plan's rep targets are snapshotted onto
    each LogSet so later edits to (or deletion of) the workout never change history.
    Consecutive entries on a day sharing a non-null superset_group form a superset.
    """

    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False, index=True)
    position = db.Column(db.Integer, nullable=False)
    exercise_id = db.Column(db.ForeignKey("exercise.id"), nullable=False)
    workout_id = db.Column(db.ForeignKey("workout.id"))  # informational: which workout it was loaded from
    superset_group = db.Column(db.Integer)
    note = db.Column(db.Text)  # this session only; shown in the exercise's history (NOTE_MAX_LENGTH)

    __table_args__ = (db.UniqueConstraint("date", "position"),)

    exercise = db.relationship("Exercise")
    workout = db.relationship("Workout")
    sets = db.relationship(
        "LogSet",
        back_populates="log_exercise",
        order_by="LogSet.position",
        cascade="all, delete-orphan",
    )


class LogSet(db.Model):
    """One set on a day: the snapshotted target plus what was actually done."""

    id = db.Column(db.Integer, primary_key=True)
    log_exercise_id = db.Column(db.ForeignKey("log_exercise.id"), nullable=False)
    position = db.Column(db.Integer, nullable=False)
    target_reps_min = db.Column(db.Integer)
    target_reps_max = db.Column(db.Integer)
    target_amrap = db.Column(db.Boolean, nullable=False, default=False)
    target_weight = db.Column(db.Float)
    target_duration_seconds = db.Column(db.Integer)
    target_distance = db.Column(db.Float)
    weight = db.Column(db.Float)            # lb
    reps = db.Column(db.Integer)
    duration_seconds = db.Column(db.Integer)
    distance = db.Column(db.Float)          # mi
    completed_at = db.Column(db.DateTime(timezone=True))

    __table_args__ = (
        db.UniqueConstraint("log_exercise_id", "position"),
        db.CheckConstraint(
            "(weight IS NULL OR weight >= 0) AND (reps IS NULL OR reps >= 0)"
            " AND (duration_seconds IS NULL OR duration_seconds >= 0)"
            " AND (distance IS NULL OR distance >= 0)",
            name="ck_log_set_non_negative",
        ),
    )

    log_exercise = db.relationship("LogExercise", back_populates="sets")

    @property
    def target_label(self):
        return rep_target_label(self.target_reps_min, self.target_reps_max, self.target_amrap)

    def to_dict(self):
        return {
            "id": self.id,
            "weight": self.weight,
            "reps": self.reps,
            "duration_seconds": self.duration_seconds,
            "distance": self.distance,
            "completed": self.completed_at is not None,
        }
