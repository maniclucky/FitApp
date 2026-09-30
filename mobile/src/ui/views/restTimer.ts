// Rest timer bar and its settings sheet on the day view (static/rest_timer.js).
// State lives in localStorage so moving between days doesn't lose a running countdown; it's
// a per-device preference, so browser storage is fine here. onSetCompleted() is called when a
// set that qualifies is checked off (see restAfterSets for the superset rule).
import { html } from "lit-html";
import { formatDuration } from "../../logic/text";
import { alarmHaptic, cancelRestAlarm, prepareRestAlarms, scheduleRestAlarm } from "../native";

const KEY = "fitapp.restTimer";
const DEFAULTS = { duration: 90, auto: true, endsAt: null as number | null };
const MIN = 15;
const MAX = 600;

export const restTimerSheet = () => html`
  <dialog class="sheet" id="timer-sheet" aria-labelledby="timer-sheet-title">
    <div class="sheet-head">
      <h2 id="timer-sheet-title">Rest timer</h2>
      <button type="button" class="button" data-close>Done</button>
    </div>
    <div class="stepper">
      <button type="button" class="icon-btn" data-step="-15" aria-label="15 seconds less">&minus;15s</button>
      <output id="timer-duration" aria-live="polite">1:30</output>
      <button type="button" class="icon-btn" data-step="15" aria-label="15 seconds more">+15s</button>
    </div>
    <div class="presets">
      ${[30, 60, 90, 120, 180].map((sec) => html`<button type="button" class="button subtle small" data-preset=${sec}>${formatDuration(sec)}</button>`)}
    </div>
    <label class="switch">
      <input type="checkbox" id="timer-auto">
      <span>Start automatically when a set is completed</span>
    </label>
    <p class="hint">In a superset, it starts only after the last exercise of each round.</p>
  </dialog>`;

export const restTimerBar = () => html`
  <div class="timer" id="timer" data-state="idle">
    <button type="button" class="timer-main" id="timer-main">
      <span class="timer-label" id="timer-label">Rest</span>
      <span class="timer-time" id="timer-time">1:30</span>
    </button>
    <button type="button" class="icon-btn running-only" data-adjust="-15" aria-label="15 seconds less">&minus;15</button>
    <button type="button" class="icon-btn running-only" data-adjust="15" aria-label="15 seconds more">+15</button>
    <button type="button" class="icon-btn" id="timer-settings" aria-label="Rest timer settings">&#9881;</button>
  </div>`;

// Audio needs a prior user gesture; one shared context for the whole app.
let audio: AudioContext | null = null;
function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    audio = null;
  }
}

function alarm() {
  alarmHaptic();
  if (!audio) return;
  for (let i = 0; i < 3; i++) {
    const t = audio.currentTime + i * 0.25;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}

export function mountRestTimer(root: HTMLElement, signal: AbortSignal): { onSetCompleted(): void } {
  const bar = root.querySelector<HTMLElement>("#timer")!;
  const label = root.querySelector<HTMLElement>("#timer-label")!;
  const time = root.querySelector<HTMLElement>("#timer-time")!;
  const sheet = root.querySelector<HTMLDialogElement>("#timer-sheet")!;
  const durationOut = root.querySelector<HTMLOutputElement>("#timer-duration")!;
  const autoBox = root.querySelector<HTMLInputElement>("#timer-auto")!;
  let tick: number | undefined;
  let doneTimer: number | undefined;
  signal.addEventListener("abort", () => {
    clearInterval(tick);
    clearTimeout(doneTimer);
  });

  const load = () => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
    } catch {
      return { ...DEFAULTS };
    }
  };
  let state = load();
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable: the timer still works while this screen is open */
    }
  };
  const remaining = () => (state.endsAt ? Math.ceil((state.endsAt - Date.now()) / 1000) : null);

  function render() {
    const r = remaining();
    if (r != null && r > 0) {
      bar.dataset.state = "running";
      label.textContent = "Resting · tap to stop";
      time.textContent = formatDuration(r);
    } else if (bar.dataset.state !== "done") {
      bar.dataset.state = "idle";
      label.textContent = state.auto ? "Rest · auto-start on" : "Start rest";
      time.textContent = formatDuration(state.duration);
    }
    durationOut.textContent = formatDuration(state.duration);
    autoBox.checked = state.auto;
  }
  function run() {
    clearInterval(tick);
    clearTimeout(doneTimer);
    tick = window.setInterval(update, 250);
    update();
  }
  function update() {
    const r = remaining();
    if (r != null && r <= 0) finish();
    else render();
  }
  function start() {
    state.endsAt = Date.now() + state.duration * 1000;
    save();
    run();
    void prepareRestAlarms(); // ask for notification permission now, not mid-rest
  }
  function stop() {
    clearInterval(tick);
    void cancelRestAlarm();
    state.endsAt = null;
    save();
    bar.dataset.state = "idle";
    render();
  }
  function finish() {
    clearInterval(tick);
    state.endsAt = null;
    save();
    bar.dataset.state = "done";
    label.textContent = "Rest over";
    time.textContent = "0:00";
    alarm();
    doneTimer = window.setTimeout(() => {
      bar.dataset.state = "idle";
      render();
    }, 8000);
  }

  document.addEventListener("pointerdown", unlockAudio, { signal });
  root.querySelector("#timer-main")!.addEventListener("click", () => (bar.dataset.state === "running" ? stop() : start()), { signal });
  bar.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLElement>("[data-adjust]");
    if (!btn || !state.endsAt) return;
    state.endsAt += Number(btn.dataset.adjust) * 1000;
    if (remaining()! <= 0) return stop();
    save();
    render();
  }, { signal });
  root.querySelector("#timer-settings")!.addEventListener("click", () => sheet.showModal(), { signal });
  sheet.addEventListener("click", (e) => {
    const t = e.target as Element;
    if (t === sheet || t.closest("[data-close]")) return sheet.close();
    const step = t.closest<HTMLElement>("[data-step]");
    const preset = t.closest<HTMLElement>("[data-preset]");
    if (step) state.duration = Math.min(MAX, Math.max(MIN, state.duration + Number(step.dataset.step)));
    else if (preset) state.duration = Number(preset.dataset.preset);
    else return;
    save();
    render();
  }, { signal });
  autoBox.addEventListener("change", () => {
    state.auto = autoBox.checked;
    save();
    render();
  }, { signal });
  // In the background the in-app alarm can't run, so a phone gets a scheduled notification
  // instead; coming back cancels it and catches up (intervals are throttled in the background).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.endsAt) void scheduleRestAlarm(state.endsAt);
    } else {
      void cancelRestAlarm();
      if (state.endsAt) update();
    }
  }, { signal });

  // Resume a countdown already running (e.g. from another day); one that expired long ago resets quietly.
  if (state.endsAt && remaining()! > -10) run();
  else {
    state.endsAt = null;
    save();
    render();
  }
  return {
    onSetCompleted() {
      if (state.auto) start();
    },
  };
}
