// Rest timer bar on the day view.
// State lives in localStorage so a page reload (e.g. after adding a set, or
// swiping to another day) doesn't lose a running countdown. It's a per-device
// preference, so browser storage is fine here.
//
// window.RestTimer.onSetCompleted() is called by day.js when a set is checked
// off and that set qualifies (see rest_after_sets in app.py for the superset rule).
(function () {
  const KEY = "fitapp.restTimer";
  const DEFAULTS = { duration: 90, auto: true, endsAt: null };
  const MIN = 15;
  const MAX = 600;

  const root = document.getElementById("timer");
  if (!root) return;
  const label = document.getElementById("timer-label");
  const time = document.getElementById("timer-time");
  const sheet = document.getElementById("timer-sheet");
  const durationOut = document.getElementById("timer-duration");
  const autoBox = document.getElementById("timer-auto");

  let state = load();
  let tick = null;
  let doneTimer = null;

  function load() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable: timer still works for this page view */
    }
  }

  const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  const remaining = () => (state.endsAt ? Math.ceil((state.endsAt - Date.now()) / 1000) : null);

  function render() {
    const r = remaining();
    if (r != null && r > 0) {
      root.dataset.state = "running";
      label.textContent = "Resting · tap to stop";
      time.textContent = fmt(r);
    } else if (root.dataset.state !== "done") {
      root.dataset.state = "idle";
      label.textContent = state.auto ? "Rest · auto-start on" : "Start rest";
      time.textContent = fmt(state.duration);
    }
    durationOut.textContent = fmt(state.duration);
    autoBox.checked = state.auto;
  }

  function run() {
    clearInterval(tick);
    clearTimeout(doneTimer);
    tick = setInterval(update, 250);
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
  }

  function stop() {
    clearInterval(tick);
    state.endsAt = null;
    save();
    root.dataset.state = "idle";
    render();
  }

  function finish() {
    clearInterval(tick);
    state.endsAt = null;
    save();
    root.dataset.state = "done";
    label.textContent = "Rest over";
    time.textContent = "0:00";
    alarm();
    doneTimer = setTimeout(() => {
      root.dataset.state = "idle";
      render();
    }, 8000);
  }

  // ---- Alarm: vibration + short beeps (audio needs a prior user gesture) ----
  let audio = null;
  function unlockAudio() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
    } catch {
      audio = null;
    }
  }
  document.addEventListener("pointerdown", unlockAudio);

  function alarm() {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
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

  // ---- Controls ----
  document.getElementById("timer-main").addEventListener("click", () => {
    root.dataset.state === "running" ? stop() : start();
  });
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-adjust]");
    if (!btn || !state.endsAt) return;
    state.endsAt += Number(btn.dataset.adjust) * 1000;
    if (remaining() <= 0) return stop();
    save();
    render();
  });

  document.getElementById("timer-settings").addEventListener("click", () => sheet.showModal());
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet || e.target.closest("[data-close]")) return sheet.close();
    const step = e.target.closest("[data-step]");
    const preset = e.target.closest("[data-preset]");
    if (step) state.duration = Math.min(MAX, Math.max(MIN, state.duration + Number(step.dataset.step)));
    else if (preset) state.duration = Number(preset.dataset.preset);
    else return;
    save();
    render();
  });
  autoBox.addEventListener("change", () => {
    state.auto = autoBox.checked;
    save();
    render();
  });

  // Catch up immediately when returning to the tab (intervals are throttled in the background).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.endsAt) update();
  });

  window.RestTimer = {
    onSetCompleted() {
      if (state.auto) start();
    },
  };

  // Resume a countdown that was running before a reload (or that ran out during the
  // reload itself); one that expired long ago while the page was closed resets quietly.
  if (state.endsAt && remaining() > -10) run();
  else {
    state.endsAt = null;
    save();
    render();
  }
})();
