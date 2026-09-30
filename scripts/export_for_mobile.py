"""Export the Flask database as a mobile-app backup file (JSON), to import into the new app.

Writes the format read by mobile/src/db/backup.ts: every table's rows, in foreign-key
order. The mobile schema (version 1) matches the Flask schema at migration 0005 column for
column, so rows transfer as they are.

    .venv/bin/python scripts/export_for_mobile.py                 # -> fitapp-backup-YYYY-MM-DD.json
    .venv/bin/python scripts/export_for_mobile.py path/out.json
"""

import argparse
import json
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "instance" / "fitapp.db"
EXPECTED_REVISION = "0005"
# Keep in sync with TABLES in mobile/src/db/schema.ts (parents before children).
TABLES = [
    "muscle_group", "exercise", "exercise_muscle", "workout", "workout_exercise", "workout_set",
    "routine", "routine_workout", "routine_muscle_target", "target_preset", "target_preset_value",
    "log_exercise", "log_set",
]


def export(db_path):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    revision = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
    if revision != EXPECTED_REVISION:
        raise SystemExit(f"Database is at migration {revision}; this exporter expects {EXPECTED_REVISION}.")
    return {
        "format": "fitapp-backup",
        "version": 1,
        "schema": 1,
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f"),
        "tables": {t: [dict(r) for r in con.execute(f"SELECT * FROM {t} ORDER BY rowid")] for t in TABLES},
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", nargs="?", type=Path, default=Path(f"fitapp-backup-{date.today().isoformat()}.json"))
    parser.add_argument("--db", type=Path, default=DB_PATH, help="Flask database to read")
    args = parser.parse_args()
    data = export(args.db)
    args.out.write_text(json.dumps(data, indent=1))
    counts = ", ".join(f"{t} {len(rows)}" for t, rows in data["tables"].items())
    print(f"Wrote {args.out} ({counts})")
