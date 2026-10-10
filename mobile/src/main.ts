// App start: open the on-device database, bring its schema up to date, make sure the default
// muscle groups exist (and, on a brand-new install, the default presets and exercises), then show the app.
import "./style.css";
import { openCapacitorDb } from "./db/capacitor";
import { migrate } from "./db/schema";
import { seedDefaultExercises } from "./logic/exercises";
import { syncMuscleGroups } from "./logic/muscles";
import { seedDefaultPresets } from "./logic/presets";
import { start } from "./ui/app";
import { initBackButton, initWebApp } from "./ui/native";
import "./ui/views/backup";
import "./ui/views/day";
import "./ui/views/exercises";
import "./ui/views/progress";
import "./ui/views/routines";
import "./ui/views/settings";
import "./ui/views/workouts";

async function main() {
  initWebApp();
  const db = await openCapacitorDb();
  const fromVersion = await migrate(db);
  await syncMuscleGroups(db);
  if (fromVersion === 0) {
    await seedDefaultPresets(db);
    await seedDefaultExercises(db);
  }
  initBackButton();
  start(db);
}

main().catch((e) => {
  console.error(e);
  document.getElementById("app")!.textContent = `FitApp couldn’t start: ${e?.message ?? e}`;
});
