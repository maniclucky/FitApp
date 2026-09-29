// Day view: autosaving set fields, completion checks, add/remove sets, loading
// workouts/exercises, the history calendar, and swipe (or arrow-key) navigation.
// Field edits save in place; structural changes reload the page (scroll is kept).
(function () {
  const day = document.getElementById("day");
  const toastEl = document.getElementById("toast");
  const dayUrl = (iso) => day.dataset.dayUrl.replace("DATE", iso);

  // ---------- helpers ----------

  let toastTimer = null;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 3500);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || "Something went wrong. Please try again.");
    return data;
  }

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- set fields ----------

  // Time accepts "m:ss" or microwave-style digits: "130" -> 1:30, "45" -> 0:45.
  function parseTime(text) {
    const t = text.trim();
    if (!t) return null;
    if (t.includes(":")) {
      const m = /^(\d*):(\d{1,2})$/.exec(t);
      return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN;
    }
    if (!/^\d+$/.test(t)) return NaN;
    const padded = t.padStart(3, "0");
    return Number(padded.slice(0, -2)) * 60 + Number(padded.slice(-2));
  }
  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

  function readField(input) {
    const raw = input.value.trim();
    if (input.dataset.field === "duration_seconds") {
      const sec = parseTime(raw);
      if (Number.isNaN(sec)) throw new Error("Time should look like 1:30 (or type 130).");
      return sec;
    }
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error("Please enter a positive number.");
    return n;
  }

  function showField(input, value) {
    if (value == null) input.value = "";
    else if (input.dataset.field === "duration_seconds") input.value = fmtTime(value);
    else input.value = String(value);
  }

  function applySet(row, data) {
    for (const input of row.querySelectorAll("input[data-field]")) {
      if (document.activeElement !== input) showField(input, data[input.dataset.field]);
      input.classList.remove("invalid");
    }
    row.classList.toggle("done", data.completed);
    row.querySelector(".check").setAttribute("aria-pressed", String(data.completed));
  }

  day.addEventListener("change", async (e) => {
    const input = e.target.closest("input[data-field]");
    if (!input) return;
    const row = input.closest("[data-set]");
    let value;
    try {
      value = readField(input);
    } catch (err) {
      input.classList.add("invalid");
      return toast(err.message);
    }
    try {
      const data = await api("PATCH", `/api/sets/${row.dataset.set}`, { [input.dataset.field]: value });
      showField(input, data[input.dataset.field]);
      input.classList.remove("invalid");
    } catch (err) {
      input.classList.add("invalid");
      toast(err.message);
    }
  });

  // Completing sends the whole row, so values typed just before tapping ✓ are never lost.
  day.addEventListener("click", async (e) => {
    const check = e.target.closest(".check");
    if (!check) return;
    const row = check.closest("[data-set]");
    const completed = check.getAttribute("aria-pressed") !== "true";
    const body = { completed };
    try {
      for (const input of row.querySelectorAll("input[data-field]")) body[input.dataset.field] = readField(input);
    } catch (err) {
      return toast(err.message);
    }
    check.disabled = true;
    try {
      const data = await api("PATCH", `/api/sets/${row.dataset.set}`, body);
      applySet(row, data);
      if (data.completed && row.dataset.rest === "1" && window.RestTimer) window.RestTimer.onSetCompleted();
    } catch (err) {
      toast(err.message);
    } finally {
      check.disabled = false;
    }
  });

  // ---------- add / remove sets ----------

  day.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const lx = btn.dataset.lx;
    btn.disabled = true;
    try {
      if (btn.dataset.act === "add-set") await api("POST", `/api/log-exercises/${lx}/sets`);
      else if (btn.dataset.act === "remove-set") await api("DELETE", `/api/log-exercises/${lx}/sets/last`);
      else return;
      location.reload();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });

  // ---------- sheets ----------

  function wireSheet(sheet, onClose) {
    sheet.addEventListener("click", (e) => {
      if (e.target === sheet || e.target.closest("[data-close]")) sheet.close();
    });
    if (onClose) sheet.addEventListener("close", onClose);
  }

  const workoutsSheet = document.getElementById("workouts-sheet");
  wireSheet(workoutsSheet);
  document.getElementById("open-workouts").addEventListener("click", () => workoutsSheet.showModal());
  workoutsSheet.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-workout-id]");
    if (!btn) return;
    btn.disabled = true;
    try {
      await api("POST", `/api/day/${day.dataset.date}/workouts`, { workout_id: Number(btn.dataset.workoutId) });
      location.reload();
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
    }
  });

  const exercisesSheet = document.getElementById("exercises-sheet");
  const options = JSON.parse(document.getElementById("exercise-options").textContent);
  const exList = document.getElementById("exercise-list");
  const exSearch = document.getElementById("exercise-search");
  const exNone = document.getElementById("exercise-none");
  const added = new Map();
  wireSheet(exercisesSheet, () => {
    if (added.size) location.reload();
  });

  function renderExercisePicker() {
    if (!exList) return;
    const q = exSearch.value.trim().toLowerCase();
    const matches = options.filter((o) => o.name.toLowerCase().includes(q));
    exList.innerHTML = matches
      .map((o) => {
        const n = added.get(o.id);
        const meta = n ? `Added${n > 1 ? ` ×${n}` : ""}` : o.modes.map((m) => m[0].toUpperCase() + m.slice(1)).join(" · ");
        return `<li><button type="button" data-exercise-id="${o.id}"><span>${esc(o.name)}</span>
          <span class="picker-meta">${esc(meta)}</span></button></li>`;
      })
      .join("");
    exNone.hidden = matches.length > 0;
  }

  document.getElementById("open-exercises").addEventListener("click", () => {
    if (exSearch) exSearch.value = "";
    renderExercisePicker();
    exercisesSheet.showModal();
  });
  if (exList) {
    exSearch.addEventListener("input", renderExercisePicker);
    exList.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-exercise-id]");
      if (!btn) return;
      const id = Number(btn.dataset.exerciseId);
      btn.disabled = true;
      try {
        await api("POST", `/api/day/${day.dataset.date}/exercises`, { exercise_id: id });
        added.set(id, (added.get(id) || 0) + 1);
        renderExercisePicker();
      } catch (err) {
        btn.disabled = false;
        toast(err.message);
      }
    });
  }

  // ---------- calendar ----------

  const calSheet = document.getElementById("calendar-sheet");
  const calTitle = document.getElementById("cal-title");
  const calGrid = document.getElementById("cal-grid");
  wireSheet(calSheet);
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const [selY, selM] = day.dataset.date.split("-").map(Number);
  let calYear = selY;
  let calMonth = selM - 1; // 0-based
  let calRequest = 0;

  async function renderCalendar() {
    const request = ++calRequest;
    const first = new Date(calYear, calMonth, 1);
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    calTitle.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    let counts = {};
    try {
      counts = await api("GET", `/api/calendar?month=${calYear}-${pad(calMonth + 1)}`);
    } catch (err) {
      toast(err.message);
    }
    if (request !== calRequest) return; // a newer month was requested meanwhile

    const cells = ["S", "M", "T", "W", "T", "F", "S"].map((d) => `<span class="cal-dow" aria-hidden="true">${d}</span>`);
    for (let i = 0; i < first.getDay(); i++) cells.push("<span></span>");
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = isoOf(calYear, calMonth, d);
      const c = counts[iso];
      const classes = ["cal-day"];
      if (iso === day.dataset.today) classes.push("today");
      if (iso === day.dataset.date) classes.push("selected");
      let status = "";
      if (c) {
        const complete = c.sets > 0 && c.done === c.sets;
        classes.push(complete ? "complete" : "partial");
        status = complete ? ", all sets done" : `, ${c.done} of ${c.sets} sets done`;
      }
      const label = new Date(calYear, calMonth, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      cells.push(`<a class="${classes.join(" ")}" href="${dayUrl(iso)}" aria-label="${esc(label + status)}"
        ${iso === day.dataset.date ? 'aria-current="date"' : ""}>${d}</a>`);
    }
    calGrid.innerHTML = cells.join("");
  }

  document.getElementById("open-calendar").addEventListener("click", () => {
    calYear = selY;
    calMonth = selM - 1;
    renderCalendar();
    calSheet.showModal();
  });
  calSheet.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-month]");
    if (!btn) return;
    calMonth += Number(btn.dataset.month);
    if (calMonth < 0) (calMonth = 11), calYear--;
    if (calMonth > 11) (calMonth = 0), calYear++;
    renderCalendar();
  });

  // ---------- swipe / arrow-key day navigation ----------

  const ENTER_KEY = "fitapp.dayEnter";
  function go(direction) {
    // direction: "next" (content leaves to the left) or "prev" (leaves to the right)
    try {
      sessionStorage.setItem(ENTER_KEY, direction);
    } catch {
      /* animation hint only */
    }
    day.classList.add(direction === "next" ? "leave-left" : "leave-right");
    setTimeout(() => (location.href = direction === "next" ? day.dataset.next : day.dataset.prev), 140);
  }

  try {
    const enter = sessionStorage.getItem(ENTER_KEY);
    sessionStorage.removeItem(ENTER_KEY);
    if (enter) day.classList.add(enter === "next" ? "enter-from-right" : "enter-from-left");
  } catch {
    /* ignore */
  }

  let touch = null;
  day.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || e.target.closest("input")) return (touch = null);
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  day.addEventListener("touchmove", (e) => {
    if (!touch) return;
    const dx = e.touches[0].clientX - touch.x;
    const dy = e.touches[0].clientY - touch.y;
    if (Math.abs(dx) > Math.abs(dy)) day.style.transform = `translateX(${dx * 0.4}px)`;
  }, { passive: true });
  day.addEventListener("touchend", (e) => {
    day.style.transform = "";
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    const quick = Date.now() - touch.t < 800;
    touch = null;
    if (quick && Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) go(dx < 0 ? "next" : "prev");
  });
  day.addEventListener("touchcancel", () => {
    day.style.transform = "";
    touch = null;
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea") || document.querySelector("dialog[open]")) return;
    if (e.key === "ArrowLeft") go("prev");
    if (e.key === "ArrowRight") go("next");
  });
})();
