# Mobile app plan
Decision and constraints for turning FitApp into a standalone Android/iPhone app.

Last updated: 2026-09-30

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
- A native iOS build later would need a cloud Mac build and a $99/yr Apple account (TestFlight or Ad Hoc). That's out of scope unless the user asks.

## Backups
- There's no cloud. Add **export to file / import from file** (a JSON backup the user saves wherever they like), plus a one-time import of the existing Flask `instance/fitapp.db` so current history carries over.
- **Keep the Android signing key safe.** An APK signed with a different key can't update the old one, so friends would have to uninstall and lose their data.

## Porting notes
- The Flask app (`app.py`, ~1.3k lines) is the reference implementation. Port rules exactly (see `data-model.md`), and check parity by running the same scenarios against both.
- The schema starts from Alembic head `0005`; on-device schema versions replace Flask-Migrate.
- Units stay lb/mi, and the long-press drag still needs real-touchscreen testing.

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
- **Gotcha: sql.js version pin.** jeep-sqlite 2.8.0 (the browser backend) bundles **sql.js 1.11.0** JavaScript, and the `sql-wasm.wasm` it loads from `public/assets/` must be the same version. Otherwise it fails with `LinkError: import object field 'I' is not a Function` and hangs at startup. `sql.js` is pinned to exactly 1.11.0, and `postinstall` copies its wasm (the copy is gitignored). Re-check the pin whenever jeep-sqlite is upgraded.
- In the browser, writes stay in memory until `saveToStore` (`persist()` in `src/db.ts`), so call it after every write.
- Flask keeps running as the reference app on port 5000 during the port.
