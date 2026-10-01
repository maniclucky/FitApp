# Mobile app plan
Decision and constraints for turning FitApp into a standalone Android/iPhone app.

Last updated: 2026-10-01 (port complete on Android; release + iPhone pending)

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
- **Android:** a signed APK built on Linux and shared directly (e.g. attached to a Codeberg release). Friends allow \"install unknown apps\" once. Capacitor gives native local notifications, so the rest-timer alarm can fire while the phone is locked.
- **iPhone (no Mac, no store):** the same offline build as an installable PWA. It's opened once in Safari from a static URL, then Share → Add to Home Screen, and from then on runs offline. Only the app's files are hosted (e.g. Codeberg Pages); user data never leaves the phone. Limits:
  - No rest-timer alarm while locked (web apps can't schedule local notifications).
  - iOS may clear site storage in rare cases, so an on-device backup file matters.
- **Chosen for iPhone (user, 2026-09-30): the installable PWA, not a native iOS build.** A native iOS build later would need a cloud Mac build and a $99/yr Apple account (TestFlight or Ad Hoc); that's out of scope unless the user asks.
- The user has an **iPad** to use as the Apple test device. Its Safari uses the same WebKit as iPhone, so it can test install, offline use, storage and touch (including the untested long-press drag). Safari can be debugged from Linux over USB with `ios-webkit-debug-proxy`/`libimobiledevice` (not installed yet; only if needed). The iPad can't build the app (no Xcode on iPadOS).
- The PWA needs a stable HTTPS static address, because iOS storage belongs to the exact origin. Moving it later means users start empty unless they Export/Import. Still open: whether the Codeberg repo can be public (required by Codeberg Pages) or another static host is used.

## Backups
- There's no cloud. Add **export to file / import from file** (a JSON backup the user saves wherever they like), plus a one-time import of the existing Flask `instance/fitapp.db` so current history carries over.
- **Keep the Android signing key safe.** An APK signed with a different key can't update the old one, so friends would have to uninstall and lose their data.

## Porting notes
- The Flask app (`app.py`, ~1.3k lines) is the reference implementation. Port rules exactly (see `data-model.md`), and check parity by running the same scenarios against both.
- The schema starts from Alembic head `0005`; on-device schema versions replace Flask-Migrate.
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
  - Bump `versionCode` (and `versionName`) in `app/build.gradle` for each release shared with friends.
  - Release builds can't be debugged over CDP or read with `run-as`, so test them with adb taps and screenshots.
- **Default data (fresh install only, `fromVersion === 0` in `main.ts`):** the presets from `defaultOptions.ods` (`DEFAULT_PRESETS`) and 86 exercises from `exerciseImport.ods` (`DEFAULT_EXERCISES` in `logic/exercises.ts`, user, 2026-10-01).
  - Sheet rules: each row is a base exercise; every equipment column marked 1 gives `"<Column> <Base>"`, except "No equipment" / "Special equipment", which give the bare base name. Every Barbell exercise also gets a `Smith Machine <Base>` version (user, 2026-10-01). Primary is one muscle; Ancillary is a comma list of 0 or more. All track weight + reps.
  - The sheet's muscle names are abbreviated (Tricep, Front Delt, Bicep, Forearm, Hamstring); they were mapped to the canonical names when copied into the TS table. `test/defaults.test.ts` fails if a name isn't canonical. The sheet's "Overheard Extension" typo was entered as "Overhead Extension".
  - Existing installs, and any database replaced by a backup import (e.g. the Flask data), don't get them; the seed skips names that already exist, so calling `seedDefaultExercises` again is safe.
- **Name fields (user, 2026-10-01):** routine, workout and exercise name inputs use `autocapitalize="words"`, so the phone keyboard shifts after each space but the user can override it. Names are not title-cased on save.
- **New exercise flow (user, 2026-10-01):** a new exercise has "Save exercise" (back to the Exercises list) and "Save & add another" (a blank form with the name field focused). Editing an existing exercise still returns to its exercise page.
- **Exercise list filter (user, 2026-10-01):** the Exercises list uses the same search + muscle + Primary/Ancillary filter as the pickers (`ui/exerciseFilter.ts`). Cards are hidden in place, not re-rendered. The filter's settings live in a module variable (`state()`/`restore()`), so they survive opening an exercise and coming back, but not an app restart.
- **Backups:** Library → Backup. Export goes to the share sheet; Import uses Android's document picker (tested on the signed release APK). Import asks for confirmation first, showing the file's contents, what it replaces, and the export date. The shared confirm panel accepts `data-confirm-label`.
- **Pending:**
  - Attach the signed APK to a Codeberg release for friends.
  - iPhone PWA: manifest, service worker, icons, and a stable HTTPS host. The user must decide on a public repo for Codeberg Pages versus another host.
  - App icon and a notification icon (Capacitor defaults for now, per the user).
  - Retire Flask once the user has moved their data (`scripts/export_for_mobile.py`, then Import).

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
