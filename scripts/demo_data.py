"""Seed or remove demo exercises and workouts for testing and visualization.

Everything created here is named with DEMO_PREFIX so it's obvious in the UI
and can be removed cleanly. Demo workouts only use demo exercises.

    .venv/bin/python scripts/demo_data.py            # (re)seed: removes old demo data first
    .venv/bin/python scripts/demo_data.py --remove   # remove all demo data
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app import app, build_workout_exercises, get_or_create_muscle  # noqa: E402
from models import (  # noqa: E402
    TRACKING_MODES,
    Exercise,
    ExerciseMuscle,
    Workout,
    WorkoutExercise,
    db,
)

DEMO_PREFIX = "[DEMO] "

# name: (tracking modes, primary muscles, ancillary muscles)
EXERCISES = {
    "Barbell Bench Press": (["weight", "reps"], ["Chest"], ["Triceps", "Shoulders"]),
    "Incline Dumbbell Press": (["weight", "reps"], ["Chest", "Shoulders"], ["Triceps"]),
    "Overhead Press": (["weight", "reps"], ["Shoulders"], ["Triceps", "Traps", "Abs"]),
    "Tricep Pushdown": (["weight", "reps"], ["Triceps"], []),
    "Pull-Up": (["weight", "reps"], ["Lats"], ["Biceps", "Upper Back", "Forearms"]),
    "Barbell Row": (["weight", "reps"], ["Upper Back", "Lats"], ["Biceps", "Lower Back"]),
    "Face Pull": (["weight", "reps"], ["Shoulders", "Upper Back"], ["Traps"]),
    "Dumbbell Curl": (["weight", "reps"], ["Biceps"], ["Forearms"]),
    "Back Squat": (["weight", "reps"], ["Quads", "Glutes"], ["Hamstrings", "Lower Back", "Abs"]),
    "Romanian Deadlift": (["weight", "reps"], ["Hamstrings", "Glutes"], ["Lower Back", "Forearms"]),
    "Walking Lunge": (["weight", "reps", "distance"], ["Quads", "Glutes"], ["Hamstrings", "Adductors", "Calves"]),
    "Standing Calf Raise": (["weight", "reps"], ["Calves"], []),
    "Plank": (["time"], ["Abs"], ["Obliques", "Shoulders"]),
    "Hanging Leg Raise": (["reps"], ["Abs", "Hip Flexors"], ["Obliques", "Forearms"]),
    "Farmer's Carry": (["weight", "time", "distance"], ["Forearms", "Traps"], ["Abs", "Obliques"]),
    "Treadmill Run": (["time", "distance"], ["Quads", "Calves"], ["Hamstrings", "Glutes"]),
    "Rowing Machine": (["time", "distance"], ["Upper Back", "Lats"], ["Quads", "Biceps", "Hamstrings"]),
    "Jump Rope": (["time"], ["Calves"], ["Shoulders", "Forearms"]),
}


def sets(*specs):
    """Set specs: '8-12', '8+' (min only), '-12' (max only), '10' (exact), 'AMRAP', '' (no target)."""
    out = []
    for spec in specs:
        if spec == "AMRAP":
            out.append({"min": None, "max": None, "amrap": True})
        elif spec.endswith("+"):
            out.append({"min": int(spec[:-1]), "max": None, "amrap": False})
        elif "-" in spec:
            lo, hi = spec.split("-")
            out.append({"min": int(lo) if lo else None, "max": int(hi), "amrap": False})
        elif spec:
            out.append({"min": int(spec), "max": int(spec), "amrap": False})
        else:
            out.append({"min": None, "max": None, "amrap": False})
    return out


def x(n, spec):
    """n identical sets."""
    return sets(*[spec] * n)


# name: list of blocks; a block with several (exercise, sets) entries is a superset.
WORKOUTS = {
    "Push Day": [
        [("Barbell Bench Press", sets("6-8", "6-8", "6-8", "AMRAP"))],
        [("Incline Dumbbell Press", x(3, "8-12"))],
        [("Overhead Press", sets("6-10", "6-10", "8+"))],
        [("Tricep Pushdown", x(3, "12-15")), ("Face Pull", x(3, "15-20"))],
        [("Plank", x(3, ""))],
    ],
    "Pull Day": [
        [("Pull-Up", sets("5+", "5+", "AMRAP"))],
        [("Barbell Row", x(4, "8-10"))],
        [("Dumbbell Curl", x(3, "10-12")), ("Face Pull", x(3, "15"))],
        [("Hanging Leg Raise", x(3, "-12"))],
    ],
    "Leg Day": [
        [("Back Squat", x(5, "5"))],
        [("Romanian Deadlift", x(3, "8-10"))],
        [("Walking Lunge", x(3, "10-12"))],
        [("Standing Calf Raise", x(4, "12-15")), ("Hanging Leg Raise", sets("10+", "10+", "AMRAP"))],
    ],
    "Full Body Circuit": [
        [("Back Squat", x(3, "10")), ("Pull-Up", x(3, "AMRAP")), ("Barbell Bench Press", x(3, "10"))],
        [("Farmer's Carry", x(3, ""))],
        [("Jump Rope", x(3, ""))],
    ],
    "Conditioning": [
        [("Treadmill Run", x(1, ""))],
        [("Rowing Machine", x(2, ""))],
        [("Plank", x(2, "")), ("Hanging Leg Raise", x(2, "AMRAP"))],
    ],
}


def demo(model):
    return select(model).where(model.name.startswith(DEMO_PREFIX, autoescape=True))


def remove():
    workouts = db.session.scalars(demo(Workout)).all()
    for w in workouts:
        db.session.delete(w)
    db.session.flush()

    removed, kept = 0, []
    for ex in db.session.scalars(demo(Exercise)).all():
        in_use = db.session.scalars(
            select(Workout.name).join(WorkoutExercise).where(WorkoutExercise.exercise_id == ex.id)
        ).all()
        if in_use:
            kept.append(f"{ex.name} (used by {', '.join(sorted(set(in_use)))})")
        else:
            db.session.delete(ex)
            removed += 1
    db.session.commit()
    print(f"Removed {len(workouts)} demo workouts and {removed} demo exercises.")
    if kept:
        print("Kept demo exercises still used by non-demo workouts:\n  " + "\n  ".join(kept))


def seed():
    exercises = {}
    for name, (modes, primary, ancillary) in EXERCISES.items():
        ex = Exercise(name=DEMO_PREFIX + name, **{f"tracks_{m}": m in modes for m in TRACKING_MODES})
        for role, muscles in (("primary", primary), ("ancillary", ancillary)):
            for muscle in muscles:
                ex.muscles.append(ExerciseMuscle(muscle_group=get_or_create_muscle(muscle), role=role))
        db.session.add(ex)
        exercises[name] = ex
    db.session.flush()

    for name, blocks in WORKOUTS.items():
        items = []
        for block in blocks:
            for n, (ex_name, ex_sets) in enumerate(block):
                items.append({
                    "exercise_id": exercises[ex_name].id,
                    "superset_next": n < len(block) - 1,
                    "sets": ex_sets,
                })
        workout = Workout(name=DEMO_PREFIX + name)
        workout.exercises.extend(build_workout_exercises(items))
        db.session.add(workout)
    db.session.commit()
    print(f"Seeded {len(EXERCISES)} demo exercises and {len(WORKOUTS)} demo workouts.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--remove", action="store_true", help="remove all demo data and exit")
    args = parser.parse_args()
    with app.app_context():
        remove()
        if not args.remove:
            seed()
