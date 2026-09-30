// Toolchain smoke test: open SQLite, write, read back, survive a reload/app restart.
import { Capacitor } from "@capacitor/core";
import { openDatabase, persist } from "./db";

const status = document.getElementById("status")!;
const rows = document.getElementById("rows")!;

async function main() {
  const db = await openDatabase();
  await db.execute("CREATE TABLE IF NOT EXISTS smoke (id INTEGER PRIMARY KEY, note TEXT NOT NULL, at TEXT NOT NULL)");
  await persist();

  async function render() {
    const result = await db.query("SELECT id, note, at FROM smoke ORDER BY id");
    rows.innerHTML = "";
    for (const r of result.values ?? []) {
      const li = document.createElement("li");
      li.textContent = `#${r.id} ${r.note} (${r.at})`;
      rows.appendChild(li);
    }
    status.textContent = `SQLite OK on ${Capacitor.getPlatform()}: ${result.values?.length ?? 0} rows`;
  }

  document.getElementById("add")!.addEventListener("click", async () => {
    await db.run("INSERT INTO smoke (note, at) VALUES (?, ?)", ["hello", new Date().toISOString()]);
    await persist();
    await render();
  });
  await render();
}

main().catch((e) => {
  status.textContent = `Error: ${e?.message ?? e}`;
  console.error(e);
});
