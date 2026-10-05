# FitApp

A mobile-first workout log built for phone screens. It runs fully offline: every person's data stays on their own device, with no accounts, servers, or sync.

- **Android:** a signed APK, installed directly (no app store).
- **iPhone / iPad:** an installable web app (Safari → Share → Add to Home Screen) that runs offline after the first launch.
- **Desktop:** the same web app in a browser.

All three are built from one TypeScript codebase in `mobile/`.

## Features

- **Day view:** log sets for any date, with weight/reps autofill, supersets, AMRAP sets, a rest timer (a background notification on Android), and long-press drag reordering.
- **Workouts:** reusable templates with per-set targets (rep ranges, weight, time, distance) and supersets. A workout can also be built from a logged day.
- **Routines:** weekly plans made of workouts, with autoregulation (rep/weight targets from the last session) and deload days.
- **Exercises:** a library of 96 default exercises with primary and ancillary muscles, search and muscle filters, and a history page per exercise.
- **Progress:** daily volume chart and sets per muscle group, measured against target presets.
- **Backups:** export to a JSON file and import it again (Library → Backup). Since there is no cloud, this is the only way to move or protect data.

## Repository layout

| Path | What it is |
|---|---|
| `mobile/` | The app: TypeScript + Vite, on-device SQLite, wrapped with Capacitor for Android |
| `mobile/src/logic/` | App rules (day log, workouts, routines, autoregulation, progress) |
| `mobile/src/db/` | Schema, migrations, and the SQLite adapters |
| `mobile/test/` | Vitest unit tests and parity tests against the Flask app |
| `app.py`, `models.py`, `templates/`, `static/`, `migrations/` | The original Flask app, kept as the reference implementation for the port; it will be retired |
| `scripts/` | Dev tools: demo data, preset import, and export of Flask data for the mobile app |
| `agent-notes/` | Design decisions and gotchas (start with `agent-notes/README.md`) |

## Development

Requires Node.js. The Android build also needs the Android SDK and a JDK (Android Studio's bundled JBR works).

```bash
cd mobile
npm install
npm test           # unit and parity tests
npm run dev        # dev server at http://127.0.0.1:5173
npm run build      # web / iPhone build in mobile/dist/
```

### Android APK

```bash
cd mobile
npm run android                                   # build the web app and sync it into android/
cd android
JAVA_HOME=~/android-studio/jbr ./gradlew assembleDebug     # debug APK
JAVA_HOME=~/android-studio/jbr ./gradlew assembleRelease   # signed release APK (needs the keystore)
```

Release builds are signed with a key kept outside the repo. Every update must use the same key, or phones refuse to install it over the existing app. Before each release, bump `versionCode` and `versionName` in `mobile/android/app/build.gradle`.

### iPhone web app

`npm run build` produces a static site in `mobile/dist/` with a manifest and a service worker that caches every file for offline use. It must be served over HTTPS from an address that never changes, because iOS ties the app's stored data to that address.

## Legacy Flask app

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python app.py                      # http://127.0.0.1:5000
.venv/bin/python scripts/demo_data.py        # optional demo data ([DEMO] prefix); --remove to clear it
```

To move Flask data into the mobile app, run `scripts/export_for_mobile.py` and import the resulting file through Library → Backup.
