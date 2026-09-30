// Backup & restore: export everything to a file, or replace everything from one. Import
// asks for confirmation first (showing what the file holds), since it replaces all data.
import { html } from "lit-html";
import { type Backup, BackupError, exportBackup, importBackup } from "../../db/backup";
import { TABLES } from "../../db/schema";
import { historyDate, todayIso } from "../../logic/text";
import { flash, refresh, route } from "../app";
import { saveFile } from "../native";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const summary = (n: Record<string, number>) =>
  `${plural(n.exercise ?? 0, "exercise")}, ${plural(n.workout ?? 0, "workout")}, ${plural(n.routine ?? 0, "routine")} and ${plural(n.log_exercise ?? 0, "logged exercise")}`;

route(/^\/backup$/, async (ctx) => {
  const counts = Object.fromEntries(await Promise.all(
    TABLES.map(async (t) => [t, (await ctx.db.all(`SELECT COUNT(*) AS n FROM ${t}`))[0].n as number] as const),
  ));
  let pending: unknown = null; // the parsed file waiting for confirmation
  ctx.onDelete("import", async () => {
    const imported = await importBackup(ctx.db, pending);
    pending = null;
    flash(`Imported ${summary(imported)}.`);
    await refresh();
  });
  return {
    title: "Backup",
    section: "backup",
    content: html`
      <header class="page-header"><h1>Backup</h1></header>
      <section class="card backup-card">
        <h2>Export</h2>
        <p class="hint">Saves all your data (${summary(counts)}) to a file. Keep a recent copy somewhere
          safe, off this phone: there's no cloud copy, so it's what protects you if the phone is lost or reset.</p>
        <button type="button" class="button block" id="export">Export backup</button>
      </section>
      <section class="card backup-card">
        <h2>Import</h2>
        <p class="hint"><strong>Replaces everything</strong> in the app with the backup's data. You'll see what the
          file contains and confirm before anything changes. If the file isn't a valid backup, nothing changes.</p>
        <label class="button subtle block file-button">
          Choose backup file…
          <input type="file" id="import" accept=".json,application/json" hidden>
        </label>
        <button type="button" id="confirm-import" hidden data-confirm-delete="import"
                data-title="Replace everything?" data-confirm-label="Replace everything"></button>
      </section>`,
    mount(root, signal) {
      root.querySelector("#export")!.addEventListener("click", async () => {
        const data = await exportBackup(ctx.db);
        await saveFile(`fitapp-backup-${todayIso()}.json`, JSON.stringify(data), "application/json");
      }, { signal });
      const input = root.querySelector<HTMLInputElement>("#import")!;
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.value = ""; // choosing the same file again should still work
        if (!file) return;
        try {
          const data = JSON.parse(await file.text()) as Partial<Backup>;
          if (data?.format !== "fitapp-backup" || !data.tables) throw new BackupError();
          const has = Object.fromEntries(Object.entries(data.tables).map(([t, rows]) => [t, Array.isArray(rows) ? rows.length : 0]));
          const when = typeof data.exported_at === "string" ? data.exported_at.slice(0, 10) : "";
          pending = data;
          const trigger = root.querySelector<HTMLButtonElement>("#confirm-import")!;
          trigger.dataset.detail =
            `This backup${when ? ` from ${historyDate(when, todayIso())}` : ""} has ${summary(has)}. ` +
            `It replaces everything in the app now (${summary(counts)}). Export first if you might want the current data back.`;
          trigger.click();
        } catch {
          flash("That file isn't a FitApp backup.", true);
          await refresh();
        }
      }, { signal });
    },
  };
});
