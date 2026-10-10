// Settings: the bottom bar's gear. Per-device preferences (rest timer, quick fill,
// autoregulation; ui/prefs.ts and restTimer.ts) and the backup export / import.
import { html } from "lit-html";
import { route } from "../app";
import { autoregulateOn, quickFillOn, setAutoregulate, setQuickFill } from "../prefs";
import { backupSettings } from "./backup";
import { mountRestTimerSettings, restTimerSettings } from "./restTimer";

route(/^\/settings$/, async (ctx) => {
  const backup = await backupSettings(ctx);
  return {
    title: "Settings",
    section: "settings",
    content: html`
      <header class="page-header"><h1>Settings</h1></header>
      ${restTimerSettings()}
      <section class="card settings-card">
        <h2>Quick fill</h2>
        <label class="switch">
          <input type="checkbox" id="quick-fill" .checked=${quickFillOn()}>
          <span>Copy the first value into the remaining sets</span>
        </label>
        <p class="hint">The first value you type in a column fills that column on the exercise's other sets:
          weight and reps on the day view, every target in the workout builder. Turn it off to fill each set yourself.</p>
      </section>
      <section class="card settings-card">
        <h2>Autoregulation</h2>
        <label class="switch">
          <input type="checkbox" id="autoregulate" .checked=${autoregulateOn()}>
          <span>Set targets from the last session</span>
        </label>
        <p class="hint">When you add to a day, rep and weight targets come from last time: one more rep if you hit
          the target, +5&nbsp;lb past the top of the rep range, −5&nbsp;lb below the bottom (8–15 when a set has no range).
          A routine or workout goes by the last time that workout was done; an exercise added on its own goes by
          its own last session. Deload days are skipped. The <strong>AR</strong> button on a card does this for one
          exercise any time.</p>
      </section>
      <h2 class="settings-heading">Backup</h2>
      ${backup.content}`,
    mount(root: HTMLElement, signal: AbortSignal) {
      mountRestTimerSettings(root, signal);
      backup.mount(root, signal);
      const quickFill = root.querySelector<HTMLInputElement>("#quick-fill")!;
      quickFill.addEventListener("change", () => setQuickFill(quickFill.checked), { signal });
      const autoregulate = root.querySelector<HTMLInputElement>("#autoregulate")!;
      autoregulate.addEventListener("change", () => setAutoregulate(autoregulate.checked), { signal });
    },
  };
});
