"""Seed or remove demo exercises, workouts, and logged history for testing and visualization.

Everything created here is named with DEMO_PREFIX so it's obvious in the UI
and can be removed cleanly. Demo workouts only use demo exercises, and demo
history (the past few weeks, ending yesterday) only logs demo exercises.

    .venv/bin/python scripts/demo_data.py            # (re)seed: removes old demo data first
    .venv/bin/python scripts/demo_data.py --remove   # remove all demo data
"""

import argparse
import random
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app import add_workout_to_day, app, build_workout_exercises, get_or_create_muscle  # noqa: E402
from models import (  # noqa: E402
    TRACKING_MODES,
    Exercise,
    ExerciseMuscle,
    LogExercise,
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


# ---- Logged history ----

HISTORY_DAYS = 35
# weekday (Mon=0) -> workout; Full Body replaces Push on odd weeks' Tuesdays for variety.
SCHEDULE = {0: "Push Day", 2: "Pull Day", 4: "Leg Day", 5: "Conditioning"}

# Starting working weight (lb) and weekly increase; missing = bodyweight/no weight.
WEIGHTS = {
    "Barbell Bench Press": (135, 5), "Incline Dumbbell Press": (45, 2.5), "Overhead Press": (85, 2.5),
    "Tricep Pushdown": (40, 2.5), "Barbell Row": (115, 5), "Face Pull": (30, 2.5),
    "Dumbbell Curl": (25, 2.5), "Back Squat": (185, 10), "Romanian Deadlift": (155, 5),
    "Walking Lunge": (30, 2.5), "Standing Calf Raise": (90, 5), "Farmer's Carry": (50, 5),
}
# (seconds range, miles range) for time/distance exercises.
CARDIO = {
    "Plank": ((45, 90), None), "Farmer's Carry": ((40, 60), (0.02, 0.04)),
    "Jump Rope": ((60, 120), None), "Treadmill Run": ((1500, 2100), (2.5, 3.5)),
    "Rowing Machine": ((480, 720), (1.1, 1.6)), "Walking Lunge": (None, (0.02, 0.03)),
}


def fill_set(log_set, name, week, rng):
    ex = log_set.log_exercise.exercise
    if ex.tracks_weight and name in WEIGHTS:
        start, step = WEIGHTS[name]
        log_set.weight = start + step * week
    if ex.tracks_reps:
        if log_set.target_amrap:
            log_set.reps = rng.randint(8, 15)
        else:
            lo = log_set.target_reps_min or max(1, (log_set.target_reps_max or 10) - 4)
            hi = log_set.target_reps_max or lo + 4
            log_set.reps = rng.randint(lo, hi)
    seconds, miles = CARDIO.get(name, (None, None))
    if ex.tracks_time and seconds:
        log_set.duration_seconds = rng.randint(*seconds)
    if ex.tracks_distance and miles:
        log_set.distance = round(rng.uniform(*miles), 2)


def seed_history(workouts):
    rng = random.Random(42)  # deterministic demo data
    today = date.today()
    first = today - timedelta(days=HISTORY_DAYS)
    sessions = []
    for offset in range(HISTORY_DAYS):
        d = first + timedelta(days=offset)
        name = SCHEDULE.get(d.weekday())
        if d.weekday() == 1 and (d.isocalendar().week % 2):
            name = "Full Body Circuit"
        if name and rng.random() > 0.12:  # skip the occasional session
            sessions.append((d, name))

    for i, (d, name) in enumerate(sessions):
        week = (d - first).days // 7
        entries = add_workout_to_day(d, workouts[name])
        db.session.flush()
        done_at = datetime.combine(d, time(18, 0), tzinfo=timezone.utc)
        for entry in entries:
            ex_name = entry.exercise.name.removeprefix(DEMO_PREFIX)
            for log_set in entry.sets:
                fill_set(log_set, ex_name, week, rng)
                log_set.completed_at = done_at
        if i == len(sessions) - 1:  # leave the latest session unfinished to show a partial day
            for log_set in entries[-1].sets:
                log_set.completed_at = None
                log_set.weight = log_set.reps = log_set.duration_seconds = log_set.distance = None
    return len(sessions)


def demo(model):
    return select(model).where(model.name.startswith(DEMO_PREFIX, autoescape=True))


def remove():
    history = db.session.scalars(
        select(LogExercise).join(Exercise).where(Exercise.name.startswith(DEMO_PREFIX, autoescape=True))
    ).all()
    for entry in history:
        db.session.delete(entry)
    days = len({entry.date for entry in history})
    db.session.flush()

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
    print(f"Removed {len(workouts)} demo workouts, {removed} demo exercises, and demo history on {days} days.")
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

    workouts = {}
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
        workouts[name] = workout
    db.session.flush()

    sessions = seed_history(workouts)
    db.session.commit()
    print(f"Seeded {len(EXERCISES)} demo exercises, {len(WORKOUTS)} demo workouts, and {sessions} days of history.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--remove", action="store_true", help="remove all demo data and exit")
    args = parser.parse_args()
    with app.app_context():
        remove()
        if not args.remove:
            seed()
