from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

TRACKING_MODES = ["weight", "reps", "time", "distance"]
MUSCLE_ROLES = ["primary", "ancillary"]

# Seeded on first run, in rough head-to-toe order (display order follows id).
DEFAULT_MUSCLE_GROUPS = [
    "Chest", "Shoulders", "Biceps", "Triceps", "Forearms",
    "Upper Back", "Lats", "Traps", "Lower Back", "Abs", "Obliques",
    "Glutes", "Hip Flexors", "Quads", "Hamstrings", "Adductors", "Abductors", "Calves",
]


def utcnow():
    return datetime.now(timezone.utc)


class Exercise(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100, collation="NOCASE"), nullable=False, unique=True)
    tracks_weight = db.Column(db.Boolean, nullable=False, default=False)
    tracks_reps = db.Column(db.Boolean, nullable=False, default=False)
    tracks_time = db.Column(db.Boolean, nullable=False, default=False)
    tracks_distance = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    muscles = db.relationship(
        "ExerciseMuscle", back_populates="exercise", cascade="all, delete-orphan"
    )

    @property
    def tracking_modes(self):
        return [m for m in TRACKING_MODES if getattr(self, f"tracks_{m}")]

    def muscle_names(self, role):
        ordered = sorted(
            (em for em in self.muscles if em.role == role),
            key=lambda em: em.muscle_group_id,
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


def seed_muscle_groups():
    if db.session.query(MuscleGroup.id).first() is None:
        db.session.add_all(MuscleGroup(name=n) for n in DEFAULT_MUSCLE_GROUPS)
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
        """Exercises grouped for display: each superset is one block, other exercises stand alone."""
        blocks = []
        for wx in self.exercises:
            if blocks and wx.superset_group is not None and blocks[-1][-1].superset_group == wx.superset_group:
                blocks[-1].append(wx)
            else:
                blocks.append([wx])
        return blocks


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
        """e.g. '3 × 8–12', '3 sets: 10, 8, AMRAP', or '2 sets'."""
        n = len(self.sets)
        labels = [s.label for s in self.sets]
        if not self.exercise.tracks_reps or not any(labels):
            return f"{n} set" if n == 1 else f"{n} sets"
        if len(set(labels)) == 1:
            return f"{n} × {labels[0]}"
        return f"{n} sets: " + ", ".join(label or "—" for label in labels)


class WorkoutSet(db.Model):
    """A planned set. Rep range bounds are each optional; AMRAP sets have no bounds."""

    id = db.Column(db.Integer, primary_key=True)
    workout_exercise_id = db.Column(db.ForeignKey("workout_exercise.id"), nullable=False)
    position = db.Column(db.Integer, nullable=False)
    reps_min = db.Column(db.Integer)
    reps_max = db.Column(db.Integer)
    is_amrap = db.Column(db.Boolean, nullable=False, default=False)

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
        if self.is_amrap:
            return "AMRAP"
        lo, hi = self.reps_min, self.reps_max
        if lo and hi:
            return str(lo) if lo == hi else f"{lo}–{hi}"
        if lo:
            return f"{lo}+"
        if hi:
            return f"≤{hi}"
        return ""
