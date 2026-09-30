"""Parity oracle: runs the Flask app's formatting/parsing helpers on edge-case inputs and
writes the results to test/fixtures/oracle-text.json for text.test.ts to compare against.

    FITAPP_SKIP_INIT=1 ../.venv/bin/python test/parity/oracle_text.py   (from mobile/)
"""
import json
import os
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("FITAPP_SKIP_INIT", "1")

import app as A  # noqa: E402
import models as M  # noqa: E402


def attempt(fn, *args, **kw):
    try:
        return {"ok": fn(*args, **kw)}
    except Exception as e:  # the message is part of the contract
        return {"error": type(e).__name__ if not str(e) else str(e)}


G = [0.0, -0.0, 1.0, 135.0, 2.25, 0.03, 12.5, 1234.5, 99999.9, 123456.0, 1234567.0, 0.0001, 0.00001,
     1e-7, 3.14159265, 2.675, 1e16, 100000.0, 999999.0, 999999.5, 12.3456789, 0.1 + 0.2, 7 * 7 / 6]
ROUND = [0.125, 0.375, 2.675, 1.005, 2.5, 0.135, 10.555, 3.14159, 0.0, 999.995, 0.015, 1.115]
NAMES = ["  Bench   Press ", "##Squat", "#  #x", "a\tb\nc", "", "   ", "x" * 120, "é" * 60, "Ab cd", "Front Delt"]
LOG = ["", None, "12", "12.345", "-1", "1e3", " 7 ", "abc", "inf", "nan", "10000", "10000.01", True, 2.5, "1_000", ".5", "5.", "+3"]
REPS = ["", None, "8", 8, "0", "1000", "8.5", 8.7, "abc", True, " 12 ", "+5", []]
DUR = ["", None, 90, "130", "1:30", ":45", "1:5", "99:99", "12:345", "abc", "0", "5", "86400", "2500:00", "240000", " 1:30 "]
NOTES = [None, "", "  hi  ", "a\r\nb", "x" * 500, "x" * 501, 5]
LABELS = [(None, None, False), (8, 12, False), (10, 10, False), (8, None, False), (None, 12, False), (None, None, True), (0, 0, False)]
TARGETS = [(8, 12, False, 135.0, None, None), (None, None, False, 50.0, 45, None), (None, None, False, None, 1500, 3.0),
           (None, None, True, 135.0, None, None), (None, None, False, None, None, None), (5, 5, False, 2.5, 65, 0.03)]
DATES = ["2026-09-30", "2026-09-29", "2026-10-01", "2025-12-31", "2000-01-05", "2026-03-31", "2024-02-29", "2026-01-15"]
MUSCLE_NAMES = ["upper chest", "neck", "Neck", "o'neil", "3d delts", "é-bras", "UPPER"]

out = {
    "formatG": [[v, format(v, "g")] for v in G],
    "round2": [[v, round(v, 2)] for v in ROUND],
    "formatNumber": [[v, A.format_number(v)] for v in [None, 135.0, 2.25, 12, 0.03, 1234567.0]],
    "formatDuration": [[v, M.format_duration(v)] for v in [None, 0, 5, 59, 60, 90, 3599, 86400]],
    "truncate1": [[v, A.truncate_one_decimal(v)] for v in [8.1666, 8.0, 0.0, 10.28125, 7 * 47 / 32, 0.1 + 0.2, 1234.99, 4.5]],
    "formatVolume": [[v, A.format_volume(v)] for v in [0.0, 1200.0, 12345.67, 201375.0, 7022.5, 999.99, 1234567.89]],
    "cleanName": [[v, A.clean_name(v, 100)] for v in NAMES],
    "cleanMuscles": [[v, A.clean_muscles(v)] for v in [["Chest", "chest", " Quads ", "", "#Abs", "ABS"]]],
    "cleanNote": [[v, attempt(A.clean_note, v, "The note")] for v in NOTES],
    "parseLogValue": [[v, attempt(A.parse_log_value, v, "Weight", integer=False, maximum=10_000),
                       attempt(A.parse_log_value, v, "Reps", integer=True, maximum=9_999)] for v in LOG],
    "parseReps": [[v, attempt(A.parse_reps, v)] for v in REPS],
    "parseDuration": [[v, attempt(A.parse_duration, v, "Plank, set 1")] for v in DUR],
    "repTargetLabel": [[list(a), M.rep_target_label(*a)] for a in LABELS],
    "setTargetLabel": [[list(a), M.set_target_label(*a)] for a in TARGETS],
    "historyDate": [[d, A.history_date(date.fromisoformat(d))] for d in DATES],
    "dayTitle": [[d, list(A.day_title(date.fromisoformat(d), date(2026, 9, 30)))] for d in DATES],
    "monthBefore": [[d, A.month_before(date.fromisoformat(d)).isoformat()] for d in DATES],
    "muscleTitle": [[n, n.title() if n.islower() else n] for n in MUSCLE_NAMES],
    "today": date.today().isoformat(),
}
dest = Path(__file__).resolve().parents[1] / "fixtures" / "oracle-text.json"
dest.write_text(json.dumps(out, ensure_ascii=False, indent=1))
print(f"wrote {dest}")
