"""Parity oracle: replays scenario.json through the real Flask app (its routes, via the test
client) on a throwaway copy of the database, and records every result plus the final state
of every table. parity.test.ts replays the same steps on the TypeScript port and must match.

    ../.venv/bin/python test/parity/oracle_scenario.py        (from mobile/)

Writes test/fixtures/scenario-start.json (backup of the starting data) and
test/fixtures/scenario-expected.json. Both contain personal data and are gitignored.
"""
import html
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
FIXTURES = HERE.parent / "fixtures"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

tmp = Path(tempfile.mkdtemp()) / "oracle.db"
shutil.copy(ROOT / "instance" / "fitapp.db", tmp)
os.environ["FITAPP_DATABASE_URI"] = f"sqlite:///{tmp}"
os.chdir(ROOT)  # Flask-Migrate finds migrations/ relative to the working directory

import app as A  # noqa: E402  (runs init_db on the copy: already at head, just syncs muscles)
import export_for_mobile  # noqa: E402
from models import Exercise, LogExercise, LogSet, Routine, Workout, db  # noqa: E402
from sqlalchemy import select, text  # noqa: E402

FIXTURES.mkdir(exist_ok=True)
(FIXTURES / "scenario-start.json").write_text(json.dumps(export_for_mobile.export(tmp), indent=1))

client = A.app.test_client()
scenario = json.loads((HERE / "scenario.json").read_text())


def sql(query, *params):
    with A.app.app_context():
        return db.session.execute(text(query), {f"p{i}": v for i, v in enumerate(params)}).fetchall()


def resolve(v):
    """Replace {"$kind": ...} references with ids looked up in the current database."""
    if isinstance(v, list):
        return [resolve(x) for x in v]
    if not isinstance(v, dict):
        return "x" * 501 if v == "NOTE_501" else v
    if len(v) == 1 and next(iter(v)).startswith("$"):
        kind, ref = next(iter(v.items()))
        table = {"$exercise": "exercise", "$workout": "workout", "$routine": "routine",
                 "$preset": "target_preset", "$muscle": "muscle_group"}.get(kind)
        if table:
            rows = sql(f"SELECT id FROM {table} WHERE name = :p0", ref)
        elif kind == "$entry":
            rows = sql("SELECT id FROM log_exercise WHERE date = :p0 AND position = :p1", *ref)
        elif kind == "$set":
            rows = sql("SELECT ls.id FROM log_set ls JOIN log_exercise lx ON lx.id = ls.log_exercise_id "
                       "WHERE lx.date = :p0 AND lx.position = :p1 AND ls.position = :p2", *ref)
        return rows[0][0] if rows else -1
    return {k: resolve(x) for k, x in v.items()}


def muscle_id(name):
    return sql("SELECT id FROM muscle_group WHERE name = :p0", name)[0][0]


def form_result(r):
    if r.status_code == 302:
        return {"ok": True}
    if r.status_code == 404:
        return {"error": "notfound"}
    page = r.data.decode()
    box = re.search(r'<div class="errors" role="alert">(.*?)</div>', page, re.S)
    return {"errors": [html.unescape(e) for e in re.findall(r"<li>(.*?)</li>", box.group(1))] if box else ["?"]}


def delete_result(url):
    r = client.post(url, follow_redirects=True)
    if r.status_code == 404:
        return {"error": "notfound"}
    err = re.search(r'<div class="flash error"[^>]*>(.*?)</div>', r.data.decode(), re.S)
    return {"error": html.unescape(err.group(1))} if err else {"ok": True}


def api_result(r, value=None):
    if r.status_code >= 400:
        data = r.get_json(silent=True)
        return {"error": data["error"] if data and "error" in data else f"http {r.status_code}"}
    return {"ok": value(r) if value else True}


def fmt_set(s, exercise):
    return {"weight": s.weight, "reps": s.reps, "duration_seconds": s.duration_seconds, "distance": s.distance,
            "completed": s.completed_at is not None, "result": A.set_result(s, exercise)}


def run(step):
    op = step["op"]
    s = resolve({k: v for k, v in step.items() if k != "op"})
    if op == "exercise.save":
        url = "/exercises/new" if s["id"] is None else f"/exercises/{s['id']}/edit"
        return form_result(client.post(url, data=s["form"]))
    if op == "exercise.delete":
        return delete_result(f"/exercises/{s['id']}/delete")
    if op == "workout.save":
        url = "/workouts/new" if s["id"] is None else f"/workouts/{s['id']}/edit"
        items = s["items"] if isinstance(s["items"], str) else json.dumps(s["items"])
        return form_result(client.post(url, data={"name": s["name"], "items": items}))
    if op == "workout.delete":
        return delete_result(f"/workouts/{s['id']}/delete")
    if op == "routine.save":
        url = "/routines/new" if s["id"] is None else f"/routines/{s['id']}/edit"
        f = s["form"]
        data = {"name": f["name"], "cycle_days": f["cycle_days"],
                "workout_ids": f["workout_ids"] if isinstance(f["workout_ids"], str) else json.dumps(f["workout_ids"])}
        data.update({f"target-{muscle_id(m)}": v for m, v in f["targets"].items()})
        return form_result(client.post(url, data=data))
    if op == "routine.delete":
        return delete_result(f"/routines/{s['id']}/delete")
    if op == "preset.save":
        url = "/presets/new" if s["id"] is None else f"/presets/{s['id']}/edit"
        data = {"name": s["name"], **{f"sets-{muscle_id(m)}": v for m, v in s["values"].items()}}
        return form_result(client.post(url, data=data))
    if op == "preset.delete":
        return delete_result(f"/presets/{s['id']}/delete")
    if op == "day.loadRoutine":
        body = {"routine_id": s["routine"], **({"index": s["index"]} if "index" in s else {})}
        return api_result(client.post(f"/api/day/{s['date']}/routines", json=body), lambda r: r.get_json()["workout"])
    if op == "day.loadWorkout":
        return api_result(client.post(f"/api/day/{s['date']}/workouts", json={"workout_id": s["workout"]}))
    if op == "day.addExercises":
        return api_result(client.post(f"/api/day/{s['date']}/exercises", json={"exercise_ids": s["ids"]}))
    if op == "day.reorder":
        ids = s["ids"]
        if ids == "ALL_ROTATED_1":
            ids = [r[0] for r in sql("SELECT id FROM log_exercise WHERE date = :p0 ORDER BY position", s["date"])]
            ids = ids[1:] + ids[:1]
        return api_result(client.post(f"/api/day/{s['date']}/order", json={"log_exercise_ids": ids}))
    if op == "day.updateSet":
        return api_result(client.patch(f"/api/sets/{s['set']}", json=s["data"]),
                          lambda r: {k: v for k, v in r.get_json().items() if k != "id"})
    if op == "day.addSet":
        return api_result(client.post(f"/api/log-exercises/{s['entry']}/sets"),
                          lambda r: {k: v for k, v in r.get_json().items() if k != "id"})
    if op == "day.removeLastSet":
        return api_result(client.delete(f"/api/log-exercises/{s['entry']}/sets/last"))
    if op == "day.notes":
        return api_result(client.patch(f"/api/log-exercises/{s['entry']}/notes", json=s["data"]), lambda r: r.get_json())
    if op == "day.deleteEntry":
        return {"ok": client.post(f"/log-exercises/{s['entry']}/delete").status_code == 302}
    if op == "day.clear":
        return {"ok": client.post(f"/day/{s['date']}/clear").status_code == 302}

    with A.app.app_context():
        if op == "read.history":
            ex = db.session.get(Exercise, s["exercise"])
            if ex is None:
                return {"error": "notfound"}
            before = date.fromisoformat(s["before"]) if s.get("before") else None
            return [{"date": x["date"].isoformat(), "workouts": x["workouts"], "notes": x["notes"],
                     "sets": [fmt_set(ls, ex) for ls in x["sets"]]} for x in A.exercise_history(ex, before)]
        if op == "read.nextIndex":
            r = db.session.get(Routine, s["routine"])
            if r is None:
                return {"error": "notfound"}
            days = [date.today() if d == "TODAY" else date.fromisoformat(d) for d in s["dates"]]
            return [A.routine_next_index(r, d) for d in days]
        if op == "read.summaries":
            return {w.name: [[[wx.exercise.name, wx.summary] for wx in block] for block in w.blocks]
                    for w in db.session.scalars(select(Workout).order_by(Workout.name))}
        if op == "read.blockers":
            return {"exercises": {e.name: A.exercise_delete_blocker(e.id)
                                  for e in db.session.scalars(select(Exercise).order_by(Exercise.name))},
                    "workouts": {w.name: A.workout_delete_blocker(w.id)
                                 for w in db.session.scalars(select(Workout).order_by(Workout.name))}}
        if op == "read.picker":
            options, muscles = A.exercise_picker_data(db.session.scalars(select(Exercise).order_by(Exercise.name)).all())
            return {"options": options, "muscles": muscles}
        if op == "read.day":
            d = date.fromisoformat(s["date"])
            entries = db.session.scalars(select(LogExercise).where(LogExercise.date == d).order_by(LogExercise.position)).all()
            rest = A.rest_after_sets(A.group_blocks(entries))
            return [{"exercise": lx.exercise.name, "workout": lx.workout.name if lx.workout else None,
                     "position": lx.position, "superset_group": lx.superset_group, "note": lx.note,
                     "sets": [{"target_label": ls.target_label, "target_weight": ls.target_weight,
                               "target_duration_seconds": ls.target_duration_seconds, "target_distance": ls.target_distance,
                               "rest_after": ls.id in rest, **fmt_set(ls, lx.exercise)} for ls in lx.sets]}
                    for lx in entries]
    if op == "read.calendar":
        return client.get(f"/api/calendar?month={s['month']}").get_json()
    if op in ("read.progress", "read.progressRange"):
        q = "&".join(f"{k}={s[k]}" for k in ("start", "end") if s.get(k))
        page = client.get(f"/progress?{q}").data.decode()
        err = re.search(r'<div class="flash error"[^>]*>(.*?)</div>', page, re.S)
        if op == "read.progressRange":
            return {"error": html.unescape(err.group(1)) if err else None}
        days = json.loads(re.search(r'id="volume-data">(.*?)</script>', page, re.S).group(1))
        muscles = re.findall(r'<th scope="row">([^<]+)</th><td>([^<]+)</td><td>([^<]+)</td>', page)
        kpis = re.findall(r'<span class="kpi-value">([^<]+)</span>', page)
        return {"days": days, "muscles": [[html.unescape(m), t, w] for m, t, w in muscles], "kpis": kpis}
    raise ValueError(f"unknown op {op}")


results = [run(step) for step in scenario["steps"]]

TIMESTAMPS = {"created_at", "completed_at"}
final = {}
for table in export_for_mobile.TABLES:
    cols = [c[1] for c in sql(f"PRAGMA table_info({table})")]
    pk = [c[1] for c in sorted(sql(f"PRAGMA table_info({table})"), key=lambda c: c[5]) if c[5]]
    rows = [dict(zip(cols, r)) for r in sql(f"SELECT * FROM {table}")]
    for row in rows:
        for k in TIMESTAMPS & row.keys():
            row[k] = None if row[k] is None else "<ts>"
    final[table] = sorted(rows, key=lambda r: [r[k] for k in pk])

(FIXTURES / "scenario-expected.json").write_text(json.dumps(
    {"today": date.today().isoformat(), "results": results, "final": final}, indent=1, ensure_ascii=False))
print(f"{len(results)} steps; wrote scenario-start.json and scenario-expected.json")
