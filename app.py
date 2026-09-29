import json
import os

from flask import Flask, flash, redirect, render_template, request, url_for
from sqlalchemy import select, update

from models import (
    MUSCLE_ROLES,
    TRACKING_MODES,
    Exercise,
    ExerciseMuscle,
    MuscleGroup,
    Workout,
    WorkoutExercise,
    WorkoutSet,
    db,
    seed_muscle_groups,
)

app = Flask(__name__)
# Relative SQLite paths resolve to Flask's instance/ folder.
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///fitapp.db"
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-only-not-secret")
db.init_app(app)

with app.app_context():
    db.create_all()
    seed_muscle_groups()


def clean_name(value, max_len):
    """Collapse whitespace, drop a leading '#', and truncate."""
    return " ".join(value.lstrip("#").split())[:max_len]


def clean_muscles(values):
    """Normalize muscle names and drop blanks and case-insensitive duplicates."""
    seen, result = set(), []
    for v in values:
        name = clean_name(v, 50)
        if name and name.lower() not in seen:
            seen.add(name.lower())
            result.append(name)
    return result


def get_or_create_muscle(name):
    muscle = db.session.scalar(select(MuscleGroup).where(MuscleGroup.name == name))
    if muscle is None:
        muscle = MuscleGroup(name=name.title() if name.islower() else name)
        db.session.add(muscle)
    return muscle


@app.route("/")
def index():
    return redirect(url_for("workouts"))


def workouts_using(exercise_id):
    return sorted(set(db.session.scalars(
        select(Workout.name).join(WorkoutExercise).where(WorkoutExercise.exercise_id == exercise_id)
    )))


@app.route("/exercises")
def exercises():
    exercises = db.session.scalars(select(Exercise).order_by(Exercise.name)).all()
    used_in = {ex.id: workouts_using(ex.id) for ex in exercises}
    return render_template("exercises.html", exercises=exercises, used_in=used_in)


@app.route("/exercises/new", methods=["GET", "POST"])
@app.route("/exercises/<int:exercise_id>/edit", methods=["GET", "POST"])
def exercise_form(exercise_id=None):
    exercise = db.get_or_404(Exercise, exercise_id) if exercise_id is not None else None
    errors = []
    if exercise:
        form = {
            "name": exercise.name,
            "tracking": exercise.tracking_modes,
            **{role: exercise.muscle_names(role) for role in MUSCLE_ROLES},
        }
    else:
        form = {"name": "", "tracking": [], "primary": [], "ancillary": []}

    if request.method == "POST":
        form["name"] = clean_name(request.form.get("name", ""), 100)
        form["tracking"] = [m for m in request.form.getlist("tracking") if m in TRACKING_MODES]
        form["primary"] = clean_muscles(request.form.getlist("primary"))
        primary_lower = {m.lower() for m in form["primary"]}
        form["ancillary"] = [
            m for m in clean_muscles(request.form.getlist("ancillary"))
            if m.lower() not in primary_lower
        ]

        duplicate = select(Exercise.id).where(Exercise.name == form["name"])
        if exercise:
            duplicate = duplicate.where(Exercise.id != exercise.id)
        if not form["name"]:
            errors.append("Name is required.")
        elif db.session.scalar(duplicate):
            errors.append(f"An exercise named \u201c{form['name']}\u201d already exists.")
        if not form["tracking"]:
            errors.append("Pick at least one tracking mode.")
        if not form["primary"]:
            errors.append("Pick at least one primary muscle group.")

        if not errors:
            if exercise:
                # Flush the removals first so re-added muscles don't collide on the
                # (exercise, muscle_group) primary key.
                exercise.muscles.clear()
                db.session.flush()
            else:
                exercise = Exercise()
                db.session.add(exercise)
            exercise.name = form["name"]
            for m in TRACKING_MODES:
                setattr(exercise, f"tracks_{m}", m in form["tracking"])
            for role in MUSCLE_ROLES:
                for name in form[role]:
                    exercise.muscles.append(
                        ExerciseMuscle(muscle_group=get_or_create_muscle(name), role=role)
                    )
            if exercise.id is not None and not exercise.tracks_reps:
                # Rep targets are meaningless once reps aren't tracked; don't leave stale ones in workouts.
                db.session.execute(
                    update(WorkoutSet)
                    .where(WorkoutSet.workout_exercise_id.in_(
                        select(WorkoutExercise.id).where(WorkoutExercise.exercise_id == exercise.id)
                    ))
                    .values(reps_min=None, reps_max=None, is_amrap=False)
                )
            db.session.commit()
            flash(f"Saved \u201c{exercise.name}\u201d.")
            return redirect(url_for("exercises"))

    # Known muscle groups, plus any custom ones from a rejected submission.
    muscles = list(db.session.scalars(select(MuscleGroup.name).order_by(MuscleGroup.id)))
    known = {m.lower() for m in muscles}
    for name in form["primary"] + form["ancillary"]:
        if name.lower() not in known:
            known.add(name.lower())
            muscles.append(name)

    return render_template(
        "exercise_form.html",
        exercise=exercise,
        used_in=workouts_using(exercise.id) if exercise else [],
        form=form,
        errors=errors,
        muscles=muscles,
        tracking_modes=TRACKING_MODES,
        selected={role: {m.lower() for m in form[role]} for role in MUSCLE_ROLES},
    ), (400 if errors else 200)


@app.route("/exercises/<int:exercise_id>/delete", methods=["POST"])
def delete_exercise(exercise_id):
    exercise = db.get_or_404(Exercise, exercise_id)
    used_in = workouts_using(exercise.id)
    if used_in:
        flash(
            f"\u201c{exercise.name}\u201d is used in {', '.join(used_in)}. Remove it from "
            "those workouts before deleting it.",
            "error",
        )
        return redirect(url_for("exercise_form", exercise_id=exercise.id))
    db.session.delete(exercise)
    db.session.commit()
    flash(f"Deleted \u201c{exercise.name}\u201d.")
    return redirect(url_for("exercises"))


@app.route("/workouts")
def workouts():
    workouts = db.session.scalars(select(Workout).order_by(Workout.name)).all()
    return render_template("workouts.html", workouts=workouts)


def parse_reps(value):
    """Return an int in 1..999, None for blank, or raise ValueError."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError
    n = int(value)
    if not 1 <= n <= 999:
        raise ValueError
    return n


def parse_workout_items(raw, exercises_by_id):
    """Validate the builder's JSON payload.

    Returns (items, errors). Items are normalized dicts safe to re-render in the builder
    and, when errors is empty, to save.
    """
    try:
        data = json.loads(raw or "[]")
    except ValueError:
        return [], ["Couldn\u2019t read the workout. Please try again."]
    if not isinstance(data, list):
        return [], ["Couldn\u2019t read the workout. Please try again."]

    items, errors = [], []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        exercise = exercises_by_id.get(entry.get("exercise_id"))
        if exercise is None:
            errors.append("One of the selected exercises no longer exists.")
            continue
        sets = []
        raw_sets = entry.get("sets") if isinstance(entry.get("sets"), list) else []
        for n, raw_set in enumerate(raw_sets, start=1):
            raw_set = raw_set if isinstance(raw_set, dict) else {}
            amrap = bool(raw_set.get("amrap")) and exercise.tracks_reps
            lo = hi = None
            if exercise.tracks_reps and not amrap:
                try:
                    lo = parse_reps(raw_set.get("min"))
                    hi = parse_reps(raw_set.get("max"))
                except (TypeError, ValueError):
                    errors.append(f"{exercise.name}, set {n}: reps must be whole numbers from 1 to 999.")
                    lo = hi = None
                if lo is not None and hi is not None and lo > hi:
                    errors.append(f"{exercise.name}, set {n}: minimum reps can\u2019t exceed maximum.")
            sets.append({"min": lo, "max": hi, "amrap": amrap})
        if not sets:
            errors.append(f"{exercise.name} needs at least one set.")
        items.append({
            "exercise_id": exercise.id,
            "superset_next": bool(entry.get("superset_next")),
            "sets": sets,
        })

    if items:
        items[-1]["superset_next"] = False  # nothing to link to
    return items, errors


def workout_to_items(workout):
    """Inverse of build_workout_exercises: the builder's JSON shape for a saved workout."""
    slots = workout.exercises
    return [
        {
            "exercise_id": wx.exercise_id,
            "superset_next": (
                wx.superset_group is not None
                and i + 1 < len(slots)
                and slots[i + 1].superset_group == wx.superset_group
            ),
            "sets": [{"min": s.reps_min, "max": s.reps_max, "amrap": s.is_amrap} for s in wx.sets],
        }
        for i, wx in enumerate(slots)
    ]


def build_workout_exercises(items):
    """Turn validated builder items into WorkoutExercise rows with contiguous superset groups."""
    slots = []
    group, next_group, prev_linked = None, 1, False
    for position, item in enumerate(items, start=1):
        if not prev_linked:
            group = None
            if item["superset_next"]:
                group, next_group = next_group, next_group + 1
        slots.append(WorkoutExercise(
            exercise_id=item["exercise_id"],
            position=position,
            superset_group=group,
            sets=[
                WorkoutSet(position=n, reps_min=s["min"], reps_max=s["max"], is_amrap=s["amrap"])
                for n, s in enumerate(item["sets"], start=1)
            ],
        ))
        prev_linked = item["superset_next"]
    return slots


@app.route("/workouts/new", methods=["GET", "POST"])
@app.route("/workouts/<int:workout_id>/edit", methods=["GET", "POST"])
def workout_builder(workout_id=None):
    workout = db.get_or_404(Workout, workout_id) if workout_id is not None else None
    all_exercises = db.session.scalars(select(Exercise).order_by(Exercise.name)).all()
    exercises_by_id = {e.id: e for e in all_exercises}
    errors = []
    if workout:
        name, items = workout.name, workout_to_items(workout)
    else:
        name, items = "", []

    if request.method == "POST":
        name = clean_name(request.form.get("name", ""), 100)
        items, errors = parse_workout_items(request.form.get("items"), exercises_by_id)
        duplicate = select(Workout.id).where(Workout.name == name)
        if workout:
            duplicate = duplicate.where(Workout.id != workout.id)
        if not name:
            errors.insert(0, "Name is required.")
        elif db.session.scalar(duplicate):
            errors.insert(0, f"A workout named \u201c{name}\u201d already exists.")
        if not items and not errors:
            errors.append("Add at least one exercise.")

        if not errors:
            if workout:
                workout.name = name
                # Replace the whole plan. Flush the deletes first so the new rows
                # don't collide with the old ones on the (workout, position) unique key.
                workout.exercises.clear()
                db.session.flush()
            else:
                workout = Workout(name=name)
                db.session.add(workout)
            workout.exercises.extend(build_workout_exercises(items))
            db.session.commit()
            flash(f"Saved \u201c{workout.name}\u201d.")
            return redirect(url_for("workouts"))

    return render_template(
        "workout_builder.html",
        workout=workout,
        name=name,
        items=items,
        errors=errors,
        exercise_options=[
            {"id": e.id, "name": e.name, "modes": e.tracking_modes} for e in all_exercises
        ],
    ), (400 if errors else 200)


@app.route("/workouts/<int:workout_id>/delete", methods=["POST"])
def delete_workout(workout_id):
    workout = db.get_or_404(Workout, workout_id)
    db.session.delete(workout)
    db.session.commit()
    flash(f"Deleted \u201c{workout.name}\u201d.")
    return redirect(url_for("workouts"))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
