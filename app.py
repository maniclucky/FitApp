import json
import math
import os
from datetime import date, timedelta

from flask import Flask, abort, flash, jsonify, redirect, render_template, request, url_for
from sqlalchemy import func, select, update

from models import (
    MUSCLE_ROLES,
    MUSCLE_SET_WEIGHTS,
    TRACKING_MODES,
    Exercise,
    ExerciseMuscle,
    LogExercise,
    LogSet,
    MuscleGroup,
    MuscleTargetDefault,
    Routine,
    RoutineMuscleTarget,
    RoutineWorkout,
    Workout,
    WorkoutExercise,
    WorkoutSet,
    db,
    group_blocks,
    ordered_muscle_groups,
    sync_muscle_groups,
    utcnow,
)

app = Flask(__name__)
# Relative SQLite paths resolve to Flask's instance/ folder.
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///fitapp.db"
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-only-not-secret")
db.init_app(app)

with app.app_context():
    db.create_all()
    sync_muscle_groups()


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
    ), (400 if errors else 200)


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


def initial_muscle_targets(routine):
    """{muscle_group_id: sets or None}: the routine's saved targets, or the defaults if it has none."""
    if routine and routine.targets:
        return {t.muscle_group_id: t.sets for t in routine.targets}
    return {d.muscle_group_id: d.sets for d in db.session.scalars(select(MuscleTargetDefault))}


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
    targets = {mg_id: format_number(v) for mg_id, v in initial_muscle_targets(routine).items()}

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
                # Flush the deletes first so new rows don't collide on the unique/primary keys.
                routine.workouts.clear()
                routine.targets.clear()
                db.session.flush()
            else:
                routine = Routine(name=name)
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
        muscle_set_weights=MUSCLE_SET_WEIGHTS,
    ), (400 if errors else 200)


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


@app.template_filter("mmss")
def format_duration(seconds):
    if seconds is None:
        return ""
    return f"{seconds // 60}:{seconds % 60:02d}"


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
                       target_amrap=ws.is_amrap)
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
