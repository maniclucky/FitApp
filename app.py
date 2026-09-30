import json
import math
import os
import re
from datetime import date, timedelta

from flask import Flask, abort, flash, jsonify, redirect, render_template, request, url_for
from alembic.runtime.migration import MigrationContext
from flask_migrate import Migrate, stamp, upgrade
from sqlalchemy import func, inspect, select, update

from models import (
    MUSCLE_ROLES,
    MUSCLE_SET_WEIGHTS,
    NOTE_MAX_LENGTH,
    TRACKING_MODES,
    Exercise,
    ExerciseMuscle,
    LogExercise,
    LogSet,
    MuscleGroup,
    Routine,
    RoutineMuscleTarget,
    RoutineWorkout,
    TargetPreset,
    TargetPresetValue,
    Workout,
    WorkoutExercise,
    WorkoutSet,
    db,
    format_duration,
    group_blocks,
    ordered_muscle_groups,
    sync_muscle_groups,
    utcnow,
)

app = Flask(__name__)
# Relative SQLite paths resolve to Flask's instance/ folder. FITAPP_DATABASE_URI points the app
# at another database (tests, generating migrations).
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("FITAPP_DATABASE_URI", "sqlite:///fitapp.db")
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-only-not-secret")
db.init_app(app)
# Batch mode: SQLite can't ALTER most things in place, so Alembic copies the table instead.
migrate = Migrate(app, db, render_as_batch=True)

# The first migration; its schema is what db.create_all() built before migrations existed.
BASELINE_REVISION = "0001"


def init_db():
    """Bring the database schema up to date, then sync the default muscle groups."""
    with db.engine.connect() as conn:
        current = MigrationContext.configure(conn).get_current_revision()
    if current is None and set(inspect(db.engine).get_table_names()) - {"alembic_version"}:
        stamp(revision=BASELINE_REVISION)  # a pre-migrations database already has the baseline schema
    upgrade()
    sync_muscle_groups()


# FITAPP_SKIP_INIT=1 is for `flask db migrate`, which must see the database untouched.
if not os.environ.get("FITAPP_SKIP_INIT"):
    with app.app_context():
        init_db()


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


def clean_note(value, label):
    """Trimmed note text with Unix newlines, or None if blank. Raises ValueError if too long."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text.")
    text = value.replace("\r\n", "\n").strip()
    if len(text) > NOTE_MAX_LENGTH:
        raise ValueError(f"{label} can be at most {NOTE_MAX_LENGTH} characters.")
    return text or None


def get_or_create_muscle(name):
    muscle = db.session.scalar(select(MuscleGroup).where(MuscleGroup.name == name))
    if muscle is None:
        muscle = MuscleGroup(name=name.title() if name.islower() else name)
        db.session.add(muscle)
    return muscle


@app.route("/")
def index():
    return redirect(url_for("day"))


def workouts_using(exercise_id):
    return sorted(set(db.session.scalars(
        select(Workout.name).join(WorkoutExercise).where(WorkoutExercise.exercise_id == exercise_id)
    )))


def exercise_delete_blocker(exercise_id):
    """Why an exercise can't be deleted (it's in a workout or has logged history), or None."""
    reasons = []
    names = workouts_using(exercise_id)
    if names:
        reasons.append(f"used in {', '.join(names)}")
    days = db.session.scalar(
        select(func.count(func.distinct(LogExercise.date))).where(LogExercise.exercise_id == exercise_id)
    )
    if days:
        reasons.append(f"logged on {days} day{'' if days == 1 else 's'}")
    if not reasons:
        return None
    where = " and ".join(
        (["those workouts" if len(names) > 1 else "that workout"] if names else [])
        + (["those days" if days > 1 else "that day"] if days else [])
    )
    return f"It\u2019s {' and '.join(reasons)}. Remove it from {where} first."


@app.route("/exercises")
def exercises():
    exercises = db.session.scalars(select(Exercise).order_by(Exercise.name)).all()
    blocked = {ex.id: exercise_delete_blocker(ex.id) for ex in exercises}
    return render_template("exercises.html", exercises=exercises, blocked=blocked)


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
            "note": exercise.note or "",
        }
    else:
        form = {"name": "", "tracking": [], "primary": [], "ancillary": [], "note": ""}

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
        form["note"] = request.form.get("note", "")
        try:
            note = clean_note(form["note"], "The note")
        except ValueError as e:
            errors.append(str(e))

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
            exercise.note = note
            for m in TRACKING_MODES:
                setattr(exercise, f"tracks_{m}", m in form["tracking"])
            for role in MUSCLE_ROLES:
                for name in form[role]:
                    exercise.muscles.append(
                        ExerciseMuscle(muscle_group=get_or_create_muscle(name), role=role)
                    )
            # Targets for a mode the exercise no longer tracks are meaningless; clear them from workouts.
            stale = {}
            if not exercise.tracks_reps:
                stale.update(reps_min=None, reps_max=None, is_amrap=False)
            for field, mode in SET_TARGETS.values():
                if not getattr(exercise, f"tracks_{mode}"):
                    stale[field] = None
            if exercise.id is not None and stale:
                db.session.execute(
                    update(WorkoutSet)
                    .where(WorkoutSet.workout_exercise_id.in_(
                        select(WorkoutExercise.id).where(WorkoutExercise.exercise_id == exercise.id)
                    ))
                    .values(**stale)
                )
            db.session.commit()
            flash(f"Saved \u201c{exercise.name}\u201d.")
            return redirect(url_for("exercise_detail", exercise_id=exercise.id))

    # Known muscle groups, plus any custom ones from a rejected submission.
    muscles = [m.name for m in ordered_muscle_groups()]
    known = {m.lower() for m in muscles}
    for name in form["primary"] + form["ancillary"]:
        if name.lower() not in known:
            known.add(name.lower())
            muscles.append(name)

    return render_template(
        "exercise_form.html",
        exercise=exercise,
        blocked=exercise_delete_blocker(exercise.id) if exercise else None,
        form=form,
        errors=errors,
        muscles=muscles,
        tracking_modes=TRACKING_MODES,
        selected={role: {m.lower() for m in form[role]} for role in MUSCLE_ROLES},
        note_max=NOTE_MAX_LENGTH,
    ), (400 if errors else 200)


# ----- Exercise history -----

HISTORY_LIMIT = 60  # most recent dates shown


def exercise_history(exercise, before=None):
    """Past sessions of an exercise, newest first: [{"date", "workouts", "sets", "notes"}].

    A session is one date. Its sets are the ones actually recorded there (completed, or
    with any value entered), in order across that day's entries; notes are that day's
    session notes. Dates with no recorded sets and no note are skipped. `before` limits
    it to dates earlier than that day.
    """
    query = (
        select(LogExercise)
        .where(LogExercise.exercise_id == exercise.id)
        .order_by(LogExercise.date.desc(), LogExercise.position)
    )
    if before is not None:
        query = query.where(LogExercise.date < before)
    sessions = []
    for lx in db.session.scalars(query):
        recorded = [
            s for s in lx.sets
            if s.completed_at is not None
            or any(v is not None for v in (s.weight, s.reps, s.duration_seconds, s.distance))
        ]
        if not recorded and not lx.note:
            continue
        if not sessions or sessions[-1]["date"] != lx.date:
            if len(sessions) == HISTORY_LIMIT:
                break
            sessions.append({"date": lx.date, "workouts": [], "sets": [], "notes": []})
        session = sessions[-1]
        if lx.note:
            session["notes"].append(lx.note)
        if lx.workout and lx.workout.name not in session["workouts"]:
            session["workouts"].append(lx.workout.name)
        session["sets"].extend(recorded)
    return sessions


@app.template_filter("set_result")
def set_result(log_set, exercise):
    """What was done in a set, for the exercise's current modes: '135 lb × 8', '50 lb · 0:45', '25:00 · 3 mi'."""
    modes = exercise.tracking_modes
    head = ""
    if "weight" in modes and log_set.weight is not None:
        head = f"{log_set.weight:g} lb"
    if "reps" in modes and log_set.reps is not None:
        head = f"{head} × {log_set.reps}" if head else f"{log_set.reps} reps"
    parts = [
        head,
        format_duration(log_set.duration_seconds) if "time" in modes else "",
        f"{log_set.distance:g} mi" if "distance" in modes and log_set.distance is not None else "",
    ]
    return " · ".join(p for p in parts if p) or "—"


@app.template_filter("history_date")
def history_date(d):
    """'Tue, Sep 29', with the year added when it isn't this year."""
    label = f"{d:%a}, {d:%b} {d.day}"
    return label if d.year == date.today().year else f"{label}, {d.year}"


@app.route("/exercises/<int:exercise_id>")
def exercise_detail(exercise_id):
    exercise = db.get_or_404(Exercise, exercise_id)
    return render_template(
        "exercise_detail.html",
        exercise=exercise,
        sessions=exercise_history(exercise),
        history_limit=HISTORY_LIMIT,
    )


@app.get("/exercises/<int:exercise_id>/history")
def exercise_history_fragment(exercise_id):
    """The history list alone (for the day view's sheet). ?before=YYYY-MM-DD skips that day and later."""
    exercise = db.get_or_404(Exercise, exercise_id)
    before = parse_day(request.args["before"]) if request.args.get("before") else None
    return render_template(
        "_exercise_history.html",
        exercise=exercise,
        sessions=exercise_history(exercise, before),
        history_limit=HISTORY_LIMIT,
    )


@app.route("/exercises/<int:exercise_id>/delete", methods=["POST"])
def delete_exercise(exercise_id):
    exercise = db.get_or_404(Exercise, exercise_id)
    blocker = exercise_delete_blocker(exercise.id)
    if blocker:
        flash(f"Can\u2019t delete \u201c{exercise.name}\u201d. {blocker}", "error")
        return redirect(url_for("exercise_form", exercise_id=exercise.id))
    db.session.delete(exercise)
    db.session.commit()
    flash(f"Deleted \u201c{exercise.name}\u201d.")
    return redirect(url_for("exercises"))


def workout_delete_blocker(workout_id):
    """Why a workout can't be deleted (a routine uses it), or None."""
    names = sorted(set(db.session.scalars(
        select(Routine.name).join(RoutineWorkout).where(RoutineWorkout.workout_id == workout_id)
    )))
    if not names:
        return None
    return (f"It\u2019s used in {', '.join(names)}. "
            f"Remove it from {'those routines' if len(names) > 1 else 'that routine'} first.")


@app.route("/workouts")
def workouts():
    workouts = db.session.scalars(select(Workout).order_by(Workout.name)).all()
    blocked = {w.id: workout_delete_blocker(w.id) for w in workouts}
    return render_template("workouts.html", workouts=workouts, blocked=blocked)


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


def parse_duration(value, label):
    """Seconds from an int, 'm:ss', or microwave-style digits ('130' -> 90); blank -> None.

    Mirrors parseTime in static/time_format.js. Raises ValueError with a user message.
    """
    if value is None or value == "":
        return None
    if isinstance(value, int) and not isinstance(value, bool):
        seconds = value
    elif isinstance(value, str) and re.fullmatch(r"\d*:\d{1,2}", value.strip()):
        minutes, secs = value.strip().split(":")
        seconds = int(minutes or 0) * 60 + int(secs)
    elif isinstance(value, str) and value.strip().isdigit():
        padded = value.strip().zfill(3)
        seconds = int(padded[:-2]) * 60 + int(padded[-2:])
    else:
        raise ValueError(f"{label}: time should look like 1:30.")
    if not 0 <= seconds <= 86_400:
        raise ValueError(f"{label}: time must be at most 24 hours.")
    return seconds


# Planned-set targets other than reps: builder JSON key -> (WorkoutSet/LogSet field, tracking mode).
SET_TARGETS = {
    "weight": ("weight", "weight"),
    "time": ("duration_seconds", "time"),
    "distance": ("distance", "distance"),
}


def parse_set_target(key, value, label):
    if key == "time":
        return parse_duration(value, label)
    if isinstance(value, str):
        value = value.strip()
    name, maximum = ("Weight", 10_000) if key == "weight" else ("Distance", 1_000)
    try:
        return parse_log_value(value, name, integer=False, maximum=maximum)
    except ValueError as e:
        raise ValueError(f"{label}: {str(e)[0].lower()}{str(e)[1:]}") from None


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
            targets = {}
            for key, (_, mode) in SET_TARGETS.items():
                targets[key] = None
                if getattr(exercise, f"tracks_{mode}"):
                    try:
                        targets[key] = parse_set_target(key, raw_set.get(key), f"{exercise.name}, set {n}")
                    except ValueError as e:
                        errors.append(str(e))
            sets.append({"min": lo, "max": hi, "amrap": amrap, **targets})
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
            "sets": [
                {"min": s.reps_min, "max": s.reps_max, "amrap": s.is_amrap,
                 **{key: getattr(s, field) for key, (field, _) in SET_TARGETS.items()}}
                for s in wx.sets
            ],
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
                WorkoutSet(
                    position=n, reps_min=s["min"], reps_max=s["max"], is_amrap=s["amrap"],
                    **{field: s.get(key) for key, (field, _) in SET_TARGETS.items()},
                )
                for n, s in enumerate(item["sets"], start=1)
            ],
        ))
        prev_linked = item["superset_next"]
    return slots


def safe_next(value):
    """A same-site path to return to, or None (guards against open redirects)."""
    if value and value.startswith("/") and not value.startswith("//") and "\\" not in value:
        return value
    return None


def exercise_picker_data(exercises):
    """(options, muscles) for an exercise picker with muscle filtering.

    options: [{id, name, modes, primary, ancillary}]; muscles: names used by any of the
    exercises, in the canonical head-to-toe order.
    """
    options = [
        {"id": e.id, "name": e.name, "modes": e.tracking_modes,
         **{role: e.muscle_names(role) for role in MUSCLE_ROLES}}
        for e in exercises
    ]
    used = {m.lower() for o in options for role in MUSCLE_ROLES for m in o[role]}
    muscles = [m.name for m in ordered_muscle_groups() if m.name.lower() in used]
    return options, muscles


@app.route("/workouts/new", methods=["GET", "POST"])
@app.route("/workouts/<int:workout_id>/edit", methods=["GET", "POST"])
def workout_builder(workout_id=None):
    workout = db.get_or_404(Workout, workout_id) if workout_id is not None else None
    back = safe_next(request.values.get("next")) or url_for("workouts")
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
            return redirect(back)

    exercise_options, muscle_options = exercise_picker_data(all_exercises)
    return render_template(
        "workout_builder.html",
        workout=workout,
        blocked=workout_delete_blocker(workout.id) if workout else None,
        back=back,
        name=name,
        items=items,
        errors=errors,
        exercise_options=exercise_options,
        muscle_options=muscle_options,
    ), (400 if errors else 200)


@app.route("/workouts/<int:workout_id>/delete", methods=["POST"])
def delete_workout(workout_id):
    workout = db.get_or_404(Workout, workout_id)
    blocker = workout_delete_blocker(workout.id)
    if blocker:
        flash(f"Can\u2019t delete \u201c{workout.name}\u201d. {blocker}", "error")
        return redirect(url_for("workout_builder", workout_id=workout.id))
    # Logged days keep their snapshotted sets; they just forget which workout they came from.
    db.session.execute(update(LogExercise).where(LogExercise.workout_id == workout.id).values(workout_id=None))
    db.session.delete(workout)
    db.session.commit()
    flash(f"Deleted \u201c{workout.name}\u201d.")
    return redirect(url_for("workouts"))


# ----- Routines -----

@app.route("/routines")
def routines():
    routines = db.session.scalars(select(Routine).order_by(Routine.name)).all()
    return render_template("routines.html", routines=routines)


def parse_routine_workout_ids(raw, workouts_by_id):
    """Validate the routine editor's JSON list of workout ids. Returns (ids, errors)."""
    try:
        data = json.loads(raw or "[]")
    except ValueError:
        data = None
    if not isinstance(data, list):
        return [], ["Couldn\u2019t read the routine. Please try again."]
    ids = [i for i in data if isinstance(i, int) and not isinstance(i, bool) and i in workouts_by_id]
    errors = [] if len(ids) == len(data) else ["One of the selected workouts no longer exists."]
    return ids, errors


def workout_muscle_sets(workout):
    """{muscle name: {"primary": sets, "ancillary": sets}} for one workout (raw set counts)."""
    totals = {}
    for wx in workout.exercises:
        for em in wx.exercise.muscles:
            counts = totals.setdefault(em.muscle_group.name, dict.fromkeys(MUSCLE_ROLES, 0))
            counts[em.role] += len(wx.sets)
    return totals


@app.route("/routines/new", methods=["GET", "POST"])
@app.route("/routines/<int:routine_id>/edit", methods=["GET", "POST"])
def routine_form(routine_id=None):
    routine = db.get_or_404(Routine, routine_id) if routine_id is not None else None
    all_workouts = db.session.scalars(select(Workout).order_by(Workout.name)).all()
    workouts_by_id = {w.id: w for w in all_workouts}
    muscle_groups = ordered_muscle_groups()
    errors, bad_targets = [], set()
    if routine:
        name, workout_ids = routine.name, [rw.workout_id for rw in routine.workouts]
    else:
        name, workout_ids = "", []
    # Values shown in the target inputs, as text so a rejected entry is re-shown as typed.
    targets = {t.muscle_group_id: format_number(t.sets) for t in routine.targets} if routine else {}
    cycle_days = str(routine.cycle_days) if routine else "7"

    if request.method == "POST":
        name = clean_name(request.form.get("name", ""), 100)
        workout_ids, errors = parse_routine_workout_ids(request.form.get("workout_ids"), workouts_by_id)
        duplicate = select(Routine.id).where(Routine.name == name)
        if routine:
            duplicate = duplicate.where(Routine.id != routine.id)
        if not name:
            errors.insert(0, "Name is required.")
        elif db.session.scalar(duplicate):
            errors.insert(0, f"A routine named \u201c{name}\u201d already exists.")
        if not workout_ids and not errors:
            errors.append("Add at least one workout.")

        cycle_days = request.form.get("cycle_days", "").strip()
        if not cycle_days.isdigit() or not 1 <= int(cycle_days) <= 365:
            errors.append("Days to complete the routine must be a whole number from 1 to 365.")

        parsed_targets = {}
        for mg in muscle_groups:
            raw = request.form.get(f"target-{mg.id}", "").strip()
            targets[mg.id] = raw
            try:
                parsed_targets[mg.id] = parse_log_value(raw, f"{mg.name} target", integer=False, maximum=999)
            except ValueError as e:
                errors.append(str(e))
                bad_targets.add(mg.id)

        if not errors:
            if routine:
                routine.name = name
                routine.cycle_days = int(cycle_days)
                # Flush the deletes first so new rows don't collide on the unique/primary keys.
                routine.workouts.clear()
                routine.targets.clear()
                db.session.flush()
            else:
                routine = Routine(name=name, cycle_days=int(cycle_days))
                db.session.add(routine)
            routine.workouts.extend(
                RoutineWorkout(workout_id=wid, position=n) for n, wid in enumerate(workout_ids, start=1)
            )
            # One row per muscle, blanks included, so a cleared target stays cleared.
            routine.targets.extend(
                RoutineMuscleTarget(muscle_group_id=mg_id, sets=sets) for mg_id, sets in parsed_targets.items()
            )
            db.session.commit()
            flash(f"Saved \u201c{routine.name}\u201d.")
            return redirect(url_for("routines"))

    return render_template(
        "routine_form.html",
        routine=routine,
        name=name,
        workout_ids=workout_ids,
        errors=errors,
        workout_options=[
            {"id": w.id, "name": w.name, "count": len(w.exercises), "muscles": workout_muscle_sets(w)}
            for w in all_workouts
        ],
        muscle_groups=muscle_groups,
        targets=targets,
        bad_targets=bad_targets,
        cycle_days=cycle_days,
        presets=[
            {"id": p.id, "name": p.name, "sets": {str(k): v for k, v in p.sets_by_muscle_id().items()}}
            for p in db.session.scalars(select(TargetPreset).order_by(TargetPreset.name))
        ],
        muscle_set_weights=MUSCLE_SET_WEIGHTS,
    ), (400 if errors else 200)


# ----- Target presets (weekly minimum sets per muscle group) -----

@app.route("/presets/new", methods=["GET", "POST"])
@app.route("/presets/<int:preset_id>/edit", methods=["GET", "POST"])
def preset_form(preset_id=None):
    preset = db.get_or_404(TargetPreset, preset_id) if preset_id is not None else None
    back = safe_next(request.values.get("next")) or url_for("routines")
    muscle_groups = ordered_muscle_groups()
    errors, bad = [], set()
    name = preset.name if preset else ""
    values = {k: format_number(v) for k, v in preset.sets_by_muscle_id().items()} if preset else {}

    if request.method == "POST":
        name = clean_name(request.form.get("name", ""), 100)
        duplicate = select(TargetPreset.id).where(TargetPreset.name == name)
        if preset:
            duplicate = duplicate.where(TargetPreset.id != preset.id)
        if not name:
            errors.append("Name is required.")
        elif db.session.scalar(duplicate):
            errors.append(f"A preset named \u201c{name}\u201d already exists.")
        parsed = {}
        for mg in muscle_groups:
            raw = request.form.get(f"sets-{mg.id}", "").strip()
            values[mg.id] = raw
            try:
                parsed[mg.id] = parse_log_value(raw, f"{mg.name} minimum", integer=False, maximum=999) or 0
            except ValueError as e:
                errors.append(str(e))
                bad.add(mg.id)
        if not errors:
            if preset:
                preset.name = name
                preset.values.clear()
                db.session.flush()
            else:
                preset = TargetPreset(name=name)
                db.session.add(preset)
            # Blank means 0; store every group so the preset is complete.
            preset.values.extend(TargetPresetValue(muscle_group_id=k, sets=v) for k, v in parsed.items())
            db.session.commit()
            flash(f"Saved preset \u201c{preset.name}\u201d.")
            return redirect(back)

    return render_template(
        "preset_form.html", preset=preset, name=name, values=values, bad=bad, errors=errors,
        muscle_groups=muscle_groups, back=back,
    ), (400 if errors else 200)


@app.post("/presets/<int:preset_id>/delete")
def delete_preset(preset_id):
    preset = db.get_or_404(TargetPreset, preset_id)
    db.session.delete(preset)
    db.session.commit()
    flash(f"Deleted preset \u201c{preset.name}\u201d.")
    return redirect(safe_next(request.values.get("next")) or url_for("routines"))


@app.route("/routines/<int:routine_id>/delete", methods=["POST"])
def delete_routine(routine_id):
    routine = db.get_or_404(Routine, routine_id)
    db.session.delete(routine)
    db.session.commit()
    flash(f"Deleted \u201c{routine.name}\u201d.")
    return redirect(url_for("routines"))


# ----- Day view -----

# How each tracking mode appears as a column in the day view.
DAY_FIELDS = {
    "weight": {"field": "weight", "label": "lb", "inputmode": "decimal"},
    "reps": {"field": "reps", "label": "Reps", "inputmode": "numeric"},
    "time": {"field": "duration_seconds", "label": "Time", "inputmode": "numeric"},
    "distance": {"field": "distance", "label": "mi", "inputmode": "decimal"},
}


@app.template_filter("num")
def format_number(value):
    """135.0 -> '135', 2.25 -> '2.25', None -> ''."""
    if value is None:
        return ""
    return f"{value:g}" if isinstance(value, float) else str(value)


app.add_template_filter(format_duration, "mmss")


def parse_day(value):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        abort(404)


def day_title(d, today):
    """(title, subtitle): 'Today' / 'Wednesday, Sep 29' or 'Jan 5' / 'Wednesday, 2000'."""
    relative = {0: "Today", -1: "Yesterday", 1: "Tomorrow"}.get((d - today).days)
    if relative:
        return relative, f"{d:%A}, {d:%b} {d.day}"
    return f"{d:%b} {d.day}", f"{d:%A}, {d.year}"


def rest_after_sets(blocks):
    """Set ids whose completion should auto-start the rest timer.

    Outside a superset: every set. In a superset, round n (the nth set of each member) ends
    with the last member that has an nth set, so only that member's nth set triggers it.
    """
    ids = set()
    for block in blocks:
        for lx in block:
            for n, log_set in enumerate(lx.sets):
                members = [m for m in block if len(m.sets) > n]
                if members[-1] is lx:
                    ids.add(log_set.id)
    return ids


@app.route("/day")
@app.route("/day/<day_str>")
def day(day_str=None):
    today = date.today()
    d = parse_day(day_str) if day_str else today
    entries = db.session.scalars(
        select(LogExercise).where(LogExercise.date == d).order_by(LogExercise.position)
    ).all()
    blocks = group_blocks(entries)
    title, subtitle = day_title(d, today)
    exercise_options, muscle_options = exercise_picker_data(
        db.session.scalars(select(Exercise).order_by(Exercise.name)).all()
    )
    workouts = db.session.scalars(select(Workout).order_by(Workout.name)).all()
    return render_template(
        "day.html",
        day=d,
        today=today,
        title=title,
        subtitle=subtitle,
        prev_day=d - timedelta(days=1),
        next_day=d + timedelta(days=1),
        blocks=blocks,
        rest_after=rest_after_sets(blocks),
        fields=DAY_FIELDS,
        note_max=NOTE_MAX_LENGTH,
        routines=[
            (r, routine_next_index(r, d))
            for r in db.session.scalars(select(Routine).order_by(Routine.name)) if r.workouts
        ],
        workouts=workouts,
        # For the "+ Add" sheet's previews: {workout id: {name, blocks: [[{name, sets}, ...], ...]}}.
        workout_summaries={
            w.id: {
                "name": w.name,
                "blocks": [[{"name": wx.exercise.name, "sets": len(wx.sets)} for wx in block] for block in w.blocks],
            }
            for w in workouts
        },
        exercise_options=exercise_options,
        muscle_options=muscle_options,
    )


def day_next_position_and_group(d):
    position, group = db.session.execute(
        select(func.max(LogExercise.position), func.max(LogExercise.superset_group)).where(LogExercise.date == d)
    ).one()
    return (position or 0) + 1, group or 0


def json_body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400)
    return data


def json_id(data, key):
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        abort(400)
    return value


def add_workout_to_day(d, workout):
    """Append a workout's exercises to a day, snapshotting its rep targets. Returns the new entries."""
    position, last_group = day_next_position_and_group(d)
    groups = {}  # workout superset_group -> day superset_group
    entries = []
    for wx in workout.exercises:
        group = None
        if wx.superset_group is not None:
            group = groups.setdefault(wx.superset_group, last_group + len(groups) + 1)
        entry = LogExercise(
            date=d,
            position=position,
            exercise_id=wx.exercise_id,
            workout_id=workout.id,
            superset_group=group,
            sets=[
                LogSet(position=n, target_reps_min=ws.reps_min, target_reps_max=ws.reps_max,
                       target_amrap=ws.is_amrap, target_weight=ws.weight,
                       target_duration_seconds=ws.duration_seconds, target_distance=ws.distance)
                for n, ws in enumerate(wx.sets, start=1)
            ],
        )
        db.session.add(entry)
        entries.append(entry)
        position += 1
    return entries


def routine_next_index(routine, d):
    """0-based index of the routine's next workout for day d, inferred from logged history.

    Finds the most recently logged workout (on or before d) that belongs to the routine and
    continues the cycle after it. When the routine repeats a workout (A / B / A), the slot is
    chosen by how far back the recent history matches the cycle. No history -> the first workout.
    """
    order = [rw.workout_id for rw in routine.workouts]
    rows = db.session.execute(
        select(LogExercise.date, LogExercise.workout_id, func.min(LogExercise.position))
        .where(LogExercise.workout_id.in_(set(order)), LogExercise.date <= d)
        .group_by(LogExercise.date, LogExercise.workout_id)
        .order_by(LogExercise.date.desc(), func.min(LogExercise.position).desc())
        .limit(len(order) * 3)
    ).all()
    history = [workout_id for _, workout_id, _ in rows]  # most recent first
    if not history:
        return 0
    n, best = len(order), None
    for p in range(n):
        if order[p] != history[0]:
            continue
        k = 1
        while k < min(len(history), n) and history[k] == order[(p - k) % n]:
            k += 1
        if best is None or k > best[0]:
            best = (k, p)
    return (best[1] + 1) % n


@app.post("/api/day/<day_str>/routines")
def api_load_routine(day_str):
    d = parse_day(day_str)
    data = json_body()
    routine = db.get_or_404(Routine, json_id(data, "routine_id"))
    if not routine.workouts:
        return jsonify(error="That routine has no workouts."), 409
    # Optional manual override ("index", 0-based) picked by cycling in the UI.
    index = json_id(data, "index") if "index" in data else routine_next_index(routine, d)
    if not 0 <= index < len(routine.workouts):
        return jsonify(error="That routine changed. Reload and try again."), 409
    workout = routine.workouts[index].workout
    add_workout_to_day(d, workout)
    db.session.commit()
    return jsonify(ok=True, workout=workout.name), 201


@app.post("/api/day/<day_str>/workouts")
def api_load_workout(day_str):
    d = parse_day(day_str)
    workout = db.get_or_404(Workout, json_id(json_body(), "workout_id"))
    add_workout_to_day(d, workout)
    db.session.commit()
    return jsonify(ok=True), 201


@app.post("/api/day/<day_str>/exercises")
def api_add_exercises(day_str):
    """Append exercises to a day, in the order given: {"exercise_ids": [id, ...]}."""
    d = parse_day(day_str)
    ids = json_body().get("exercise_ids")
    if not isinstance(ids, list) or not ids or any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
        abort(400)
    by_id = {e.id: e for e in db.session.scalars(select(Exercise).where(Exercise.id.in_(ids)))}
    if len(by_id) != len(set(ids)):
        return jsonify(error="One of the selected exercises no longer exists."), 404
    position, _ = day_next_position_and_group(d)
    for offset, exercise_id in enumerate(ids):
        set_count = 3 if by_id[exercise_id].tracks_reps else 1
        db.session.add(LogExercise(
            date=d,
            position=position + offset,
            exercise_id=exercise_id,
            sets=[LogSet(position=n) for n in range(1, set_count + 1)],
        ))
    db.session.commit()
    return jsonify(ok=True), 201


@app.post("/api/day/<day_str>/order")
def api_reorder_day(day_str):
    """Reorder a day's exercises: {"log_exercise_ids": [every id on that day, in the new order]}.

    Supersets must stay contiguous (the UI drags them as one block).
    """
    d = parse_day(day_str)
    ids = json_body().get("log_exercise_ids")
    if not isinstance(ids, list) or any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
        abort(400)
    entries = {lx.id: lx for lx in db.session.scalars(select(LogExercise).where(LogExercise.date == d))}
    if len(ids) != len(set(ids)) or set(ids) != set(entries):
        return jsonify(error="This day changed. Reload and try again."), 409
    seen, prev = set(), None
    for i in ids:
        group = entries[i].superset_group
        if group is not None and group != prev and group in seen:
            return jsonify(error="A superset can\u2019t be split up."), 400
        seen.add(group)
        prev = group
    # Park everything on negative positions first so the (date, position) unique key never collides.
    for n, i in enumerate(ids, start=1):
        entries[i].position = -n
    db.session.flush()
    for n, i in enumerate(ids, start=1):
        entries[i].position = n
    db.session.commit()
    return jsonify(ok=True)


def parse_log_value(value, label, *, integer, maximum):
    """Blank -> None; otherwise a finite number in [0, maximum]. Raises ValueError with a user message."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a number.")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a number.") from None
    if not math.isfinite(number) or not 0 <= number <= maximum:
        raise ValueError(f"{label} must be between 0 and {maximum:,}.")
    if integer:
        if number != int(number):
            raise ValueError(f"{label} must be a whole number.")
        return int(number)
    return round(number, 2)


LOG_FIELDS = {
    "weight": dict(label="Weight", integer=False, maximum=10_000),
    "reps": dict(label="Reps", integer=True, maximum=9_999),
    "duration_seconds": dict(label="Time", integer=True, maximum=86_400),
    "distance": dict(label="Distance", integer=False, maximum=1_000),
}


@app.patch("/api/sets/<int:set_id>")
def api_update_set(set_id):
    log_set = db.get_or_404(LogSet, set_id)
    data = json_body()
    try:
        for field, spec in LOG_FIELDS.items():
            if field in data:
                setattr(log_set, field, parse_log_value(data[field], **spec))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    if "completed" in data:
        log_set.completed_at = (log_set.completed_at or utcnow()) if data["completed"] else None
    db.session.commit()
    return jsonify(log_set.to_dict())


@app.post("/api/log-exercises/<int:lx_id>/sets")
def api_add_log_set(lx_id):
    lx = db.get_or_404(LogExercise, lx_id)
    last = lx.sets[-1] if lx.sets else None
    log_set = LogSet(
        position=last.position + 1 if last else 1,
        target_reps_min=last.target_reps_min if last else None,
        target_reps_max=last.target_reps_max if last else None,
        target_amrap=last.target_amrap if last else False,
        target_weight=last.target_weight if last else None,
        target_duration_seconds=last.target_duration_seconds if last else None,
        target_distance=last.target_distance if last else None,
    )
    lx.sets.append(log_set)
    db.session.commit()
    return jsonify(log_set.to_dict()), 201


@app.delete("/api/log-exercises/<int:lx_id>/sets/last")
def api_remove_last_log_set(lx_id):
    lx = db.get_or_404(LogExercise, lx_id)
    if len(lx.sets) <= 1:
        return jsonify(error="An exercise needs at least one set. Remove the exercise instead."), 409
    last = lx.sets[-1]
    if last.completed_at is not None:
        return jsonify(error="The last set is completed. Un-check it before removing it."), 409
    db.session.delete(last)
    db.session.commit()
    return "", 204


@app.patch("/api/log-exercises/<int:lx_id>/notes")
def api_update_notes(lx_id):
    """Set a logged exercise's notes: {"exercise_note": ..., "session_note": ...} (either key optional).

    exercise_note is stored on the exercise itself, so it shows everywhere it's used;
    session_note belongs to this day's entry. Blank clears a note.
    """
    lx = db.get_or_404(LogExercise, lx_id)
    data = json_body()
    try:
        if "exercise_note" in data:
            lx.exercise.note = clean_note(data["exercise_note"], "The exercise note")
        if "session_note" in data:
            lx.note = clean_note(data["session_note"], "The session note")
    except ValueError as e:
        return jsonify(error=str(e)), 400
    db.session.commit()
    return jsonify(exercise_note=lx.exercise.note, session_note=lx.note)


@app.post("/log-exercises/<int:lx_id>/delete")
def delete_log_exercise(lx_id):
    lx = db.get_or_404(LogExercise, lx_id)
    d, name = lx.date, lx.exercise.name
    db.session.delete(lx)
    db.session.commit()
    flash(f"Removed \u201c{name}\u201d from this day.")
    return redirect(url_for("day", day_str=d.isoformat()))


@app.post("/day/<day_str>/clear")
def clear_day(day_str):
    d = parse_day(day_str)
    entries = db.session.scalars(select(LogExercise).where(LogExercise.date == d)).all()
    for lx in entries:
        db.session.delete(lx)
    db.session.commit()
    if entries:
        flash(f"Removed {len(entries)} exercise{'' if len(entries) == 1 else 's'} from this day.")
    return redirect(url_for("day", day_str=d.isoformat()))


# ----- Progress -----

PROGRESS_MAX_DAYS = 366


def month_before(d):
    """The same day one calendar month earlier, clamped to that month's length (Mar 31 -> Feb 28)."""
    year, month = (d.year, d.month - 1) if d.month > 1 else (d.year - 1, 12)
    last_day = (date(year + month // 12, month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(d.day, last_day))


def progress_range(args, today):
    """(start, end, error) from ?start=&end= (YYYY-MM-DD). Defaults to the past month, ending today."""
    try:
        end = date.fromisoformat(args["end"]) if args.get("end") else today
        start = date.fromisoformat(args["start"]) if args.get("start") else month_before(end)
    except ValueError:
        return month_before(today), today, "Dates should look like 2026-09-30."
    if start > end:
        return start, end, "The start date is after the end date."
    if (end - start).days + 1 > PROGRESS_MAX_DAYS:
        return start, end, f"Pick a range of at most {PROGRESS_MAX_DAYS} days."
    return start, end, None


@app.route("/progress")
def progress():
    """Daily volume (sum of weight × reps) and sets per muscle group over a date range.

    Only completed sets count. Muscle sets use the same weighting as routine volume
    planning (MUSCLE_SET_WEIGHTS: primary 1, ancillary 0.5) with each exercise's current
    muscle groups; per week = total × 7 / days in range.
    """
    today = date.today()
    start, end, error = progress_range(request.args, today)
    if error:
        flash(error, "error")
        start, end = month_before(today), today
    n_days = (end - start).days + 1
    in_range = (LogExercise.date >= start, LogExercise.date <= end, LogSet.completed_at.is_not(None))

    volume_by_day = dict(db.session.execute(
        select(LogExercise.date, func.sum(LogSet.weight * LogSet.reps))
        .join(LogSet)
        .where(*in_range, LogSet.weight.is_not(None), LogSet.reps.is_not(None))
        .group_by(LogExercise.date)
    ).all())
    days = [
        {"date": (d := start + timedelta(days=i)).isoformat(), "volume": round(volume_by_day.get(d) or 0, 2)}
        for i in range(n_days)
    ]

    sets_by_exercise = dict(db.session.execute(
        select(LogExercise.exercise_id, func.count(LogSet.id)).join(LogSet).where(*in_range)
        .group_by(LogExercise.exercise_id)
    ).all())
    muscle_sets = {}
    for exercise in db.session.scalars(select(Exercise).where(Exercise.id.in_(sets_by_exercise))):
        for em in exercise.muscles:
            muscle_sets[em.muscle_group_id] = (
                muscle_sets.get(em.muscle_group_id, 0) + sets_by_exercise[exercise.id] * MUSCLE_SET_WEIGHTS[em.role]
            )
    muscles = [
        {"name": mg.name, "total": muscle_sets.get(mg.id, 0), "per_week": muscle_sets.get(mg.id, 0) * 7 / n_days}
        for mg in ordered_muscle_groups()
    ]

    return render_template(
        "progress.html",
        start=start, end=end, today=today, n_days=n_days, days=days, muscles=muscles,
        total_volume=sum(d["volume"] for d in days),
        training_days=sum(1 for d in days if d["volume"]),
        completed_sets=sum(sets_by_exercise.values()),
        presets=[("Week", today - timedelta(days=6)), ("Month", month_before(today)),
                 ("3 months", month_before(month_before(month_before(today))))],
    )


@app.template_filter("trunc1")
def truncate_one_decimal(value):
    """Cut off (not round) to one decimal: 8.1666 -> '8.1', 8.0 -> '8'."""
    cut = math.floor(value * 10 + 1e-9) / 10
    return f"{cut:g}"


@app.template_filter("volume")
def format_volume(value):
    """Thousands-separated, cut off at one decimal: 12345.67 -> '12,345.6', 1200.0 -> '1,200'."""
    cut = math.floor(value * 10 + 1e-9) / 10
    return f"{cut:,.1f}".removesuffix(".0")


app.add_template_filter(date.fromisoformat, "fromiso")


@app.get("/api/calendar")
def api_calendar():
    """Per-day set counts for a month: {"YYYY-MM-DD": {"sets": n, "done": n}}."""
    try:
        first = date.fromisoformat(request.args.get("month", "") + "-01")
    except ValueError:
        abort(400)
    after = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    rows = db.session.execute(
        select(LogExercise.date, func.count(LogSet.id), func.count(LogSet.completed_at))
        .join(LogSet)
        .where(LogExercise.date >= first, LogExercise.date < after)
        .group_by(LogExercise.date)
    ).all()
    return jsonify({d.isoformat(): {"sets": n, "done": done} for d, n, done in rows})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
