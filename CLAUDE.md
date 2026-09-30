# FitApp

## Agent notes (required)
The `agent-notes/` folder is the shared knowledge base for agents working on this project.

- **Read first:** At the start of every task, read `agent-notes/README.md` and any notes in its index relevant to the task.
- **Write back:** When you learn something a future agent would need — a design decision, a non-obvious gotcha, a fix that took real investigation, an external reference — record it in `agent-notes/` following the conventions in `agent-notes/README.md`, and add it to the index.
- **Keep it accurate:** If a note is outdated or wrong, update or delete it in the same change that made it so.
- Never put secrets or credentials in `agent-notes/`.

## Project
Mobile-first fitness & health web app (targets phone screens), built in Python with Flask + Flask-SQLAlchemy (SQLite). Runs on localhost only until the user says otherwise.

## Running locally
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # first time only
.venv/bin/python app.py                                              # http://127.0.0.1:5000
```
Mobile app (`mobile/`, the offline Capacitor app replacing Flask):
```bash
cd mobile && npm install && npm test          # unit + Flask-parity tests
npm run dev                                   # browser dev server, http://127.0.0.1:5173
npm run android && (cd android && ./gradlew assembleDebug)   # APK (needs JAVA_HOME=~/android-studio/jbr)
```

Startup applies any pending database migrations (Flask-Migrate, `migrations/`). Schema changes need a new migration; see `agent-notes/data-model.md` for the workflow.

## Demo data
Test data for development and visualization. Every exercise and workout it creates is named with a `[DEMO] ` prefix.
```bash
.venv/bin/python scripts/demo_data.py            # (re)seed: clears old demo data first
.venv/bin/python scripts/demo_data.py --remove   # remove all demo data
```
When adding new models or features, extend `scripts/demo_data.py` so the demo set keeps covering them.

## UI conventions
- Lists are tappable cards: tapping a card opens its edit form, and a × in the corner deletes. Edit forms also have a red Delete button at the bottom. Every delete goes through the shared confirmation panel. New list types should follow the same pattern.
- Exception (user request): an **exercise** card opens the exercise page (`/exercises/<id>`: details plus history), which has an **Edit** button for the form.

## Layout
- `app.py` — Flask app, config, and routes
- `models.py` — SQLAlchemy models + seed data (SQLite DB lives at `instance/fitapp.db`, gitignored)
- `templates/` — Jinja HTML templates
- `static/` — CSS and per-page JS (`exercise_form.js`, `workout_builder.js`, `routine_form.js`, `day.js`, `rest_timer.js`, `confirm_delete.js`, `exercise_filter.js`, `nav.js`, `time_format.js`, `progress.js`)
- JSON API under `/api/...` is used by the day view (set autosave, loading routines/workouts/exercises, reordering, calendar counts)
- `scripts/` — dev utilities (demo data; `import_presets.py` loads target presets from `defaultOptions.ods`)
- `migrations/` — Alembic migrations (`0001` baseline = the schema before migrations existed)
- `mobile/` — the offline Capacitor app (TypeScript) replacing Flask; being ported on `feature/mobile-app`. Setup, build and emulator steps are in `agent-notes/mobile-app-plan.md`
- `templates/_confirm_delete.html` + `static/confirm_delete.js` — shared delete confirmation, opened by any button with `data-confirm-delete="<POST url>" data-name="..."` (optional `data-title` to replace the question, `data-detail`, `data-blocked`)
- `templates/_exercise_filter.html` + `static/exercise_filter.js` — shared exercise search with muscle / primary-ancillary filter for pickers
- Routes: `/` → `/day` (today; `/day/<YYYY-MM-DD>` for others; `POST /day/<date>/clear`), `/progress` (`?start=&end=`), `/routines`, `/routines/new` and `/routines/<id>/edit`, `/workouts`, `/workouts/new` and `/workouts/<id>/edit` (builder), `/exercises`, `/exercises/<id>` (page with history), `/exercises/new` and `/exercises/<id>/edit`, `/presets/new` and `/presets/<id>/edit`; `POST .../<id>/delete` for each
