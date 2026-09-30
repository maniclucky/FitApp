"""Import target presets (weekly minimum sets per muscle group) from a spreadsheet.

Layout: the first row holds preset names (one per column, from column B on); each later
row is a muscle group name in column A followed by that group's value in each preset.
Muscle names match the app's groups case-insensitively, and "Delts" is read as "Deltoid"
(so "Front Delts" -> "Front Deltoid"). Groups the sheet doesn't list get 0. A preset whose
name already exists is replaced. Reads .ods with the standard library only.

    .venv/bin/python scripts/import_presets.py defaultOptions.ods
"""

import argparse
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app import app  # noqa: E402
from models import TargetPreset, TargetPresetValue, db, ordered_muscle_groups  # noqa: E402

_TABLE = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
_OFFICE = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
_TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
MAX_REPEAT = 200  # blank cells/rows are stored as huge repeat counts; nothing real is that wide


def read_ods_rows(path):
    """Rows of the first sheet as lists of strings (numbers as their text), trailing blanks trimmed."""
    root = ET.fromstring(zipfile.ZipFile(path).read("content.xml"))
    sheet = next(root.iter(_TABLE + "table"))
    rows = []
    for row in sheet.iter(_TABLE + "table-row"):
        cells = []
        for cell in row:
            if cell.tag not in (_TABLE + "table-cell", _TABLE + "covered-table-cell"):
                continue
            text = cell.get(_OFFICE + "value") or " ".join("".join(p.itertext()) for p in cell.iter(_TEXT + "p"))
            cells.extend([text.strip()] * min(int(cell.get(_TABLE + "number-columns-repeated", 1)), MAX_REPEAT))
        while cells and not cells[-1]:
            cells.pop()
        rows.extend([cells] * min(int(row.get(_TABLE + "number-rows-repeated", 1)), MAX_REPEAT))
    return [r for r in rows if r]


def normalize(name):
    return re.sub(r"\bdelts\b", "deltoid", " ".join(name.split()).lower())


def import_presets(path):
    header, *body = read_ods_rows(path)
    names = [n for n in header[1:] if n]
    muscles = {normalize(m.name): m for m in ordered_muscle_groups()}
    values = {n: {} for n in names}  # preset name -> {muscle_group_id: sets}
    unknown = []
    for row in body:
        muscle = muscles.get(normalize(row[0]))
        if muscle is None:
            unknown.append(row[0])
            continue
        for col, preset_name in enumerate(names, start=1):
            raw = row[col] if col < len(row) else ""
            values[preset_name][muscle.id] = float(raw) if raw else 0.0
    if unknown:
        sys.exit(f"Unknown muscle groups in {path}: {', '.join(unknown)}. Nothing imported.")

    for preset_name, sets in values.items():
        preset = db.session.scalar(select(TargetPreset).where(TargetPreset.name == preset_name))
        if preset is None:
            preset = TargetPreset(name=preset_name)
            db.session.add(preset)
        else:
            preset.values.clear()
            db.session.flush()
        preset.values.extend(
            TargetPresetValue(muscle_group_id=m.id, sets=sets.get(m.id, 0.0)) for m in muscles.values()
        )
        listed = sum(1 for v in sets.values() if v)
        print(f"{preset_name}: {listed} groups above 0, {sum(sets.values()):g} sets/week "
              f"({len(muscles) - len(sets)} groups not in the sheet set to 0)")
    db.session.commit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", type=Path, help=".ods spreadsheet to import")
    args = parser.parse_args()
    with app.app_context():
        import_presets(args.path)
