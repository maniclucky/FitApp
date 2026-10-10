// Settings: the bottom bar's gear. Per-device preferences: the rest timer and quick fill.
// The routine Autoregulation switch is still hidden; it moves here later (user request).
import { html } from "lit-html";
import { route } from "../app";
import { quickFillOn, setQuickFill } from "../prefs";
import { mountRestTimerSettings, restTimerSettings } from "./restTimer";

route(/^\/settings$/, async () => ({
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
    </section>`,
  mount(root: HTMLElement, signal: AbortSignal) {
    mountRestTimerSettings(root, signal);
    const quickFill = root.querySelector<HTMLInputElement>("#quick-fill")!;
    quickFill.addEventListener("change", () => setQuickFill(quickFill.checked), { signal });
  },
}));
