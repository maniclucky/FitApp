# Mobile app plan
Decision and constraints for turning FitApp into a standalone Android/iPhone app.

Last updated: 2026-10-01 (port complete on Android; iPhone web-app build done, hosting pending)

## Decision (user, 2026-09-30)
- **Everything runs on the phone.** The Python logic is ported to TypeScript, with an on-device SQLite database, wrapped with **Capacitor**. The existing HTML/CSS/JS is reused as far as possible.
- **One codebase, never built twice (user, 2026-09-30).** The same TypeScript web app runs in a desktop browser (this is how "keep the webapp" is satisfied), as the Android APK, and as the iPhone home-screen app. The Flask/Python app is only the reference during the port; once the new app matches it, Flask is retired. Don't add features to Flask in the meantime. The user isn't keen to learn TypeScript, so keep the code plain and close to the existing JS style.
- **Audience:** the user plus a few friends, avoiding the app stores.
- **Hard constraints:**
  - It must work with no connection.
  - **No servers, accounts, sync, or hosted user data.** The user said: "I don't want to deal with data, or networks or anything of the sort."
  - The user is on Linux with no Mac.
  - Each person's data lives only on their own phone.

## Distribution
- **Android:** a signed APK built on Linux and shared directly (e.g. attached to a GitHub release). Friends allow \"install unknown apps\" once. Capacitor gives native local notifications, so the rest-timer alarm can fire while the phone is locked.
- **iPhone (no Mac, no store):** the same offline build as an installable PWA. It's opened once in Safari from a static URL, then Share → Add to Home Screen, and from then on runs offline. Only the app's files are hosted (e.g. GitHub Pages); user data never leaves the phone. Limits:
  - No rest-timer alarm while locked (web apps can't schedule local notifications).
  - iOS may clear site storage in rare cases, so an on-device backup file matters.
- **Chosen for iPhone (user, 2026-09-30): the installable PWA, not a native iOS build.** A native iOS build later would need a cloud Mac build and a $99/yr Apple account (TestFlight or Ad Hoc); that's out of scope unless the user asks.
- The user has an **iPad** to use as the Apple test device. Its Safari uses the same WebKit as iPhone, so it can test install, offline use, storage and touch (including the untested long-press drag). Safari can be debugged from Linux over USB with `ios-webkit-debug-proxy`/`libimobiledevice` (not installed yet; only if needed). The iPad can't build the app (no Xcode on iPadOS).
- The PWA needs a stable HTTPS static address, because iOS storage belongs to the exact origin. Moving it later means users start empty unless they Export/Import. Still open: whether the GitHub repo is public (GitHub Pages needs a public repo on the free plan) or another static host is used. (The repo moved from Codeberg to GitHub on 2026-10-05; Codeberg bans AI-generated code.).

## Backups
- There's no cloud. Add **export to file / import from file** (a JSON backup the user saves wherever they like), plus a one-time import of the existing Flask `instance/fitapp.db` so current history carries over.
- **Keep the Android signing key safe.** An APK signed with a different key can't update the old one, so friends would have to uninstall and lose their data.

## Porting notes
- The Flask app (`app.py`, ~1.3k lines) is the reference implementation. Port rules exactly (see `data-model.md`), and check parity by running the same scenarios against both.
- The schema starts from Alembic head `0005`; on-device schema versions replace Flask-Migrate. v2 (2026-10-01) adds `progress_target`; append new migrations to `MIGRATIONS` in `db/schema.ts` and never edit a shipped one.
- Units stay lb/mi, and the long-press drag still needs real-touchscreen testing.

## Status (2026-09-30)
- **Done:**
  - Schema v1 and backups (phase 2).
  - All logic ported with parity tests (phase 3).
  - All screens ported (phase 4).
  - Android native features: back button, share-sheet export, haptics, background rest notification.
  - Tested in Firefox (34 checks, output compared with Flask on the same data) and on an Android 16 emulator (12 checks).
- **Release signing (set up 2026-09-30):** the key is at `~/.fitapp-release/fitapp-release.jks` (alias `fitapp`, RSA 4096, valid 10000 days, SHA-256 `f3:83:8f:bf:…:f4:f5:df`). Its random password is in `~/.fitapp-release/keystore.properties` (mode 600). Both are outside the repo, and the user must back them up off this machine.
  - `android/app/build.gradle` reads that file, or the one named by `FITAPP_KEYSTORE_PROPERTIES`. Without it, release builds are unsigned.
  - **Every update must be signed with this same key**, or phones refuse to install it over the old app.
  - Build with `./gradlew assembleRelease`, which produces `app/build/outputs/apk/release/app-release.apk`. Check it with `apksigner verify --print-certs`.
  - **Every build the user asks for bumps the version first (user rule, 2026-10-01):** `versionCode` + 1 and the `versionName` patch + 1 (0.1.1 → 0.1.2) in `app/build.gradle`. Builds made only for testing don't bump it.
  - Release builds can't be debugged over CDP or read with `run-as`, so test them with adb taps and screenshots.
- **Default data (fresh install only, `fromVersion === 0` in `main.ts`):** the presets from `defaultOptions.ods` (`DEFAULT_PRESETS`) and 96 exercises from `exerciseImport.ods` (`DEFAULT_EXERCISES` in `logic/exercises.ts`, user, 2026-10-01).
  - Sheet rules: each row is a base exercise; every equipment column marked 1 gives `"<Column> <Base>"`, except "No equipment" / "Special equipment", which give the bare base name. Every Barbell exercise also gets a `Smith Machine <Base>` version (user, 2026-10-01). Primary is one muscle; Ancillary is a comma list of 0 or more. All track weight + reps.
  - The sheet's muscle names are abbreviated (Tricep, Front Delt, Bicep, Forearm, Hamstring); they were mapped to the canonical names when copied into the TS table. `test/defaults.test.ts` fails if a name isn't canonical. The sheet's "Overheard Extension" typo was entered as "Overhead Extension". User decisions (2026-10-01): the sheet's "When" row stays **Flye** (an accidental edit), and Hip Adductor / Hip Abductor get Adductors / Abductors (the sheet had them swapped).
  - Existing installs, and any database replaced by a backup import (e.g. the Flask data), don't get them; the seed skips names that already exist, so calling `seedDefaultExercises` again is safe.
- **Name fields (user, 2026-10-01):** routine, workout and exercise name inputs use `autocapitalize="words"`, so the phone keyboard shifts after each space but the user can override it. Names are not title-cased on save.
- **New exercise flow (user, 2026-10-01):** a new exercise has "Save exercise" (back to the Exercises list) and "Save & add another" (a blank form with the name field focused). Editing an existing exercise still returns to its exercise page.
- **New exercise from the workout builder (user, 2026-10-01):** the picker sheet's **+ New** opens `#/exercises/new?next=<builder route>`. That form has the same Save / Save & add another buttons, but Save and its back arrow return to the builder (an exercise opened without `?next=` still returns to the list). Every exercise saved on the way, chained ones included, is added to the end of the workout on return (`takeCreatedExercises` in `views/exercises.ts`, keyed by the return route). The unsaved workout (name, sets, autofill state) waits in an in-memory `drafts` map keyed by the builder route, the same way the routine editor handles presets.
- **Primary/ancillary chips (user, 2026-10-01; differs from Flask):** a muscle selected in one list is greyed out in the other (`.chip.taken`) but not disabled. Tapping it there moves the muscle to that list and deselects it in the first. Custom muscles added through either "Add" box move the same way. Flask's form disabled the twin chip instead.
- **Exercise list filter (user, 2026-10-01):** the Exercises list uses the same search + muscle + Primary/Ancillary filter as the pickers (`ui/exerciseFilter.ts`). Cards are hidden in place, not re-rendered. The filter's settings live in a module variable (`state()`/`restore()`), so they survive opening an exercise and coming back, but not an app restart.
- **Copy workout / routine (user, 2026-10-01):** a copy icon on each list card (beside the ×) and a **Copy** button in the editor header open `#/workouts/new?copy=<id>` / `#/routines/new?copy=<id>`. That is a new, unsaved editor holding every setting of the saved original (sets, targets, supersets; workouts, days, weekly targets) and the name `<name> NEW` (`ui/copy.ts`, kept within 100 characters). Unsaved edits in the editor aren't included.
- **Build workout from day (user, 2026-10-01):** a day with exercises shows **Build workout from day**, which opens `#/workouts/new?day=<date>&next=#/day/<date>`. The name is blank, so it must be typed in. Exercises keep their order, supersets and set counts, and every target is blank: no rep range, AMRAP, weight, time or distance (`dayToWorkoutItems` in `logic/day.ts`). Saving returns to the day.
- **Day view autofill (user, 2026-10-01):** the first weight or reps value typed for an exercise is copied, as you type, into that column on its *later* sets that are empty and not checked off. Those sets are saved when the field is committed. After that the column counts as filled and sets are edited independently. A column with any value already (e.g. after a reload) counts as filled. An invalid value isn't copied. Time and distance aren't autofilled because the user only asked for weight and reps.
- **Long-press reorder is shared (`ui/dragReorder.ts`, 2026-10-01):** the day view and the routine editor use it. The routine editor's ↑/↓ buttons were removed at the user's request; the workout builder still has them. In the day view, every card collapses to its name while dragging (user request; `.log-list.collapsed`). When it lifts, the helper keeps the item's top where it was on screen and makes its centre follow the finger. After collapsing, a short page can clamp the scroll, so the lifted card may jump to the finger. Still only verified with a mouse.
- **Day view superset button (user, 2026-10-01):** each card except the day's last has a link-↓ toggle in its action row (instead of the builder's between-card toggles, to save vertical space). `setSupersetWithNext` in `logic/day.ts` links an exercise with the one below. If either is already in a superset, it joins that superset, and two supersets merge. Unlinking splits the superset at that point, and a group left with one exercise becomes NULL. The toggle is pressed (accent colour) while the two are linked.
- **Progress targets (user, 2026-10-01; schema v2):** the Progress page's "Sets per muscle group" uses the same rows as Volume Planning, with a weekly minimum input and a bar against "per week" for the selected range. Each target is saved when its field is committed, in **`progress_target`** (`muscle_group_id` PK, `sets` ≥ 0). That table is the app's first schema migration (v2) and doesn't exist in Flask. Its **Presets** sheet loads a preset (replacing every target; a group the preset lacks gets 0) or saves the current targets as a new preset (blank = 0, the name must be new). Edit links go to the preset page and back.
  - Backups export the current schema (`schema: 3` since autoregulation, see `autoregulation.md`). An older backup (including Flask's) imports with no progress targets or deload days, and new columns take their defaults. `test/backup.test.ts` and `test/parity.test.ts` treat tables missing from the Flask fixtures as empty, and compare rows through `asFlaskRows` (`test/sqljs.ts`), which drops mobile-only columns that hold their default. Add any new mobile-only column there.
  - `syncMuscleGroups` counts `progress_target` as a reference before deleting a retired muscle group.
- **Backups:** Library → Backup. Export goes to the share sheet; Import uses Android's document picker (tested on the signed release APK). Import asks for confirmation first, showing the file's contents, what it replaces, and the export date. The shared confirm panel accepts `data-confirm-label`.
- **Pending:**
  - Attach the signed APK to a GitHub release for friends.
  - iPhone PWA: a stable HTTPS host (the build side is done, see below). The user must decide on a public repo for GitHub Pages versus another host.
  - Test the PWA on the user's iPad: install, offline launch, share-sheet export, long-press drag, safe-area padding.
  - App icon and a notification icon (Capacitor defaults for now, per the user).
  - Retire Flask once the user has moved their data (`scripts/export_for_mobile.py`, then Import).

## iPhone web app (PWA, built 2026-10-01)
- **The host is only needed to install and to update** (user's point, 2026-10-01). After the first launch every file is on the phone, and the app runs with the host gone. But the host's address must never change: iOS ties the data to it, and updates come from it. If iOS evicts the cached files under storage pressure, the app can't start again until the host is reachable.
- `public/manifest.webmanifest` and the Apple tags in `index.html` (`apple-touch-icon`, `black-translucent` status bar so `env(safe-area-inset-*)` pads the content). The icons in `public/icons/` are a placeholder dumbbell (generated with PIL), not final art.
- **Service worker:** `mobile/sw.js` is a template. The `fitapp-service-worker` plugin in `vite.config.ts` writes `dist/sw.js` after each build with the list of every file in `dist/` and a version hashed from their contents. It caches everything at install and serves from the cache, falling back to the network.
  - It deliberately doesn't call `skipWaiting`: a new version takes over at the next launch after every window of the old one has closed, so a running app never loses chunks it still lazy-loads (`web-*.js`). The old cache is deleted on activation. Verified in headless Chromium.
  - It's registered only in the web build (`initWebApp` in `ui/native.ts`, `import.meta.env.PROD`, not native), so the Android APK and the dev server never use it. `initWebApp` also calls `navigator.storage.persist()`.
- **jeep-sqlite's `wasmpath` defaults to the absolute `/assets`.** `db/capacitor.ts` sets it to `./assets`, so the app also works from a sub-folder such as `https://<user>.github.io/FitApp/`.
- **Export:** home-screen apps on iOS don't download files reliably, so `saveFile` uses the web share sheet (`navigator.share` with a `File`) on touch devices that support it. If the share is refused (`NotAllowedError`), it falls back to a download; closing the sheet does nothing. Desktop browsers still download.
- **Tell friends:** use only the home-screen icon. iOS keeps a home-screen app's storage separate from Safari tabs, so data logged in Safari won't show up in the app.
- **Temporary hosting works (user plan, 2026-10-01):** host only while someone installs, then take it down. Because of the separate storage, each person must open the **home-screen icon** once while the host is still up (the Safari visit alone doesn't cache the app for the icon).
  - If iOS evicts the site, the files and the data go together. Recovery means hosting again, reinstalling, and importing a backup the person saved outside the app (Files/iCloud). A backup import also works across a different address.
- **Tested** in headless Chromium (Playwright from a scratch venv, `dist/` served under `/fitapp/`): the defaults are seeded, an exercise is saved, the page reloads with the network off, and a fresh launch works with the server stopped. Not yet tested on iOS.

## Code layout (mobile/src)
- `db/`: the `Db` interface (`types.ts`), the Capacitor adapter, `schema.ts` (versioned by `PRAGMA user_version`), and `backup.ts`.
- `logic/`: the port of `app.py`, one module per area. It's pure data work over `Db`, with no DOM, so it's unit-testable under Node.
- `ui/app.ts`: the shell.
  - Hash routes and the bottom bar.
  - Flash messages.
  - The shared delete confirmation: a button has `data-confirm-delete="<key>"`, and the view registers `ctx.onDelete(key, action)`.
  - `stash()`/`takeStash()` carry a rejected form's errors and values across the re-render.
  - Every navigation re-renders from scratch and aborts the previous view's listeners, so views add listeners with `{ signal }`.
- `ui/views/`: one file per area. Each is a lit-html template plus a `mount()` holding the old `static/*.js` behaviour.
- `ui/native.ts`: Capacitor plugins, with web fallbacks.

## Tests
- `npm test` (vitest, sql.js under Node):
  - `backup.test.ts`: schema, cascades, backup round trip.
  - `text.test.ts`: helpers against `test/parity/oracle_text.py` output.
  - `parity.test.ts`: replays `test/parity/scenario.json` (69 steps) and must match the Flask oracle's results and final tables exactly.
- Regenerate the fixtures (gitignored, personal data) with `../.venv/bin/python test/parity/oracle_text.py`, `test/parity/oracle_scenario.py` and `../scripts/export_for_mobile.py test/fixtures/flask-backup.json` (from `mobile/`).
- **On-device testing:** Playwright's `connect_over_cdp` can't attach to an Android WebView; it disconnects. Instead:
  1. Forward the WebView's page socket: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`.
  2. Send `Runtime.evaluate` over `ws://127.0.0.1:9333/devtools/page/<id>` with websocket-client.
  3. Drive native parts with adb (`input keyevent BACK/HOME`, `dumpsys notification`, `run-as ... cat databases/fitappSQLite.db`).
  - Grant `POST_NOTIFICATIONS` with `pm grant` for tests.

## Gotchas found during the port
- **Back stack (user, 2026-10-01: back from an edited exercise must reach the list, not the edit form):** `app.ts` stores the route each history entry was opened from in `history.state.from`. `returnTo(target)` calls `history.back()` when the current screen was opened from `target`, and otherwise uses `location.replace(target)`, which carries `from` over. Every `a.back` ← arrow goes through it (a global click handler), and so do the exercise form's and workout builder's saves. The routine and preset saves still use `navigate()`, which pushes a new entry; switch them to `returnTo` if their back stack matters.
- **`canGoBack` is unreliable here:** the Android WebView's `canGoBack` (from the App plugin's backButton event) ignores `#` route changes. Use `history.length` instead.
- **Row counts from `run()` include cascaded deletes** on the Capacitor web/Android backends, but not under plain sql.js. Never use them for user-facing counts; `COUNT(*)` first.
- **Match Python where output is compared:** `{:g}` formatting (`formatG`), `round(x, 2)` rounding exact halves to even (`round2`, checked against the exact binary expansion), `%` never being negative, `str.title()`/`islower()`, and truncation by characters.
- **`clean_name` only strips `#` at the very start:** `"  ##x"` keeps its `#`s because the leading whitespace comes first. Flask behaves the same way.

## Toolchain (set up and proven 2026-09-30)
- The code lives in `mobile/` (Vite + TypeScript + lit-html + Capacitor 8 + `@capacitor-community/sqlite`), on branch `feature/mobile-app`. `mobile/src/main.ts` is currently only a SQLite smoke test.
- **Node** v24 LTS comes from **nvm** (`~/.nvm`, loaded by `~/.bashrc`). In a non-interactive shell, run `export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh` first.
- **Android**, with nothing extra installed: `JAVA_HOME=$HOME/android-studio/jbr` (Android Studio's bundled JDK; the system Java is a JRE only) and `ANDROID_HOME=$HOME/Android/Sdk`.
  - Build: `cd mobile && npm run build && npx cap sync android && cd android && ./gradlew assembleDebug`, which produces `android/app/build/outputs/apk/debug/app-debug.apk`.
- **Emulator:** AVD `fitapp_test` (Android 16, `system-images;android-36;google_apis;x86_64`; KVM works).
  - Headless: `$ANDROID_HOME/emulator/emulator -avd fitapp_test -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot`, then `adb install -r <apk>`.
  - **Testing gotchas:**
    - `uiautomator dump` is flaky with the WebView and sometimes returns nothing, so don't trust it for assertions.
    - Verify data by copying the DB out: `adb exec-out run-as org.fitapp.app cat databases/fitappSQLite.db > x.db` (the plugin appends `SQLite.db` to the name).
    - Screenshots are 1080×2400; recompute tap coordinates after the layout changes.
- **Status bar / camera overlap (edge-to-edge):**
  - On Android WebView ≥ Chromium 140, Capacitor 8 draws the app edge-to-edge, and `env(safe-area-inset-*)` and the injected `--safe-area-inset-*` carry the real insets. Below 140, Capacitor pads the WebView itself and both are 0.
  - `style.css` pads `.screen` by `--inset-top` (the max of the two) and uses `--inset-bottom` at the bottom, so neither case double-pads.
  - The window/WebView background is the app's dark colour (`colors.xml`, `backgroundColor` in `capacitor.config.ts`), and SystemBars `style: "DARK"` gives light status-bar icons.
  - The emulator image has Chromium 133, so it **can't show the edge-to-edge case**. Simulate it in a browser by setting `--safe-area-inset-top` on `:root`.
- **Don't `pkill -f <pattern>` from a shell whose own command line contains the pattern:** it kills that shell. Stop servers by port (`fuser -k 4173/tcp`).
- **Gotcha: sql.js version pin.** jeep-sqlite 2.8.0 (the browser backend) bundles **sql.js 1.11.0** JavaScript, and the `sql-wasm.wasm` it loads from `public/assets/` must be the same version. Otherwise it fails with `LinkError: import object field 'I' is not a Function` and hangs at startup. `sql.js` is pinned to exactly 1.11.0, and `postinstall` copies its wasm (the copy is gitignored). Re-check the pin whenever jeep-sqlite is upgraded.
- In the browser, writes stay in memory until `saveToStore` (`persist()` in `src/db.ts`), so call it after every write.
- Flask keeps running as the reference app on port 5000 during the port.
