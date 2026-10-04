// The day view: logging sets, the "+ Add" sheet (routines / workouts / exercises), history
// and notes sheets, long-press reordering, the calendar, swipe navigation and the rest
// timer. Ported from templates/day.html, static/day.js and static/rest_timer.js.
import { html, render } from "lit-html";
import { isDeload, repRange, setDeload } from "../../logic/autoregulation";
import * as day from "../../logic/day";
import { type LogEntry, type LogSet } from "../../logic/day";
import { exercisePickerData, getExercise, type PickerOption } from "../../logic/exercises";
import { exerciseHistory } from "../../logic/history";
import { listRoutines, routineNextIndex } from "../../logic/routines";
import {
  addDays, dayTitle, formatDuration, formatNumber, historyDate, NOTE_MAX_LENGTH, parseIsoDate, type TrackingMode,
} from "../../logic/text";
import { groupBlocks, listWorkouts } from "../../logic/workouts";
import { type Ctx, flash, href, navigate, refresh, route } from "../app";
import { exerciseFilter, filterControls } from "../exerciseFilter";
import { longPressReorder } from "../dragReorder";
import { formatTime, parseTime } from "../time";
import { historyList } from "./history";
import { tapHaptic } from "../native";
import { mountRestTimer, restTimerBar, restTimerSheet } from "./restTimer";

// How each tracking mode appears as a column.
const FIELDS: Record<TrackingMode, { field: keyof LogSet; label: string; inputmode: string }> = {
  weight: { field: "weight", label: "lb", inputmode: "decimal" },
  reps: { field: "reps", label: "Reps", inputmode: "numeric" },
  time: { field: "duration_seconds", label: "Time", inputmode: "numeric" },
  distance: { field: "distance", label: "mi", inputmode: "decimal" },
};

const linkIcon = html`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>`;

route(/^\/day$/, (ctx) => dayView(ctx, ctx.today));
route(/^\/day\/([^/]+)$/, (ctx) => dayView(ctx, ctx.params[0]));

async function dayView(ctx: Ctx, date: string) {
  if (!parseIsoDate(date)) throw new Error("That isn’t a valid date.");
  const { db, today } = ctx;
  const isToday = date === today;
  const entries = await day.dayEntries(db, date);
  const deload = await isDeload(db, date);
  const blocks = groupBlocks(entries);
  const restAfter = day.restAfterSets(blocks);
  const [title, subtitle] = dayTitle(date, today);
  const prev = addDays(date, -1);
  const next = addDays(date, 1);
  const workouts = await listWorkouts(db);
  const routines = await Promise.all((await listRoutines(db)).filter((r) => r.workout_ids.length)
    .map(async (r) => ({ routine: r, next: await routineNextIndex(db, r, date) })));
  const workoutNames = new Map(workouts.map((w) => [w.id, w.name]));
  const summaries = Object.fromEntries(workouts.map((w) => [w.id, {
    name: w.name,
    blocks: groupBlocks(w.slots).map((block) => block.map((wx) => ({ name: wx.exercise.name, sets: wx.sets.length }))),
  }]));
  const { options, muscles } = await exercisePickerData(db);
  const nExercises = entries.length;
  const dayLabel = isToday ? "today" : historyDate(date, today);

  for (const lx of entries) {
    ctx.onDelete(`entry:${lx.id}`, async () => {
      const name = await day.deleteLogEntry(db, lx.id);
      flash(`Removed “${name}” from this day.`);
      await refresh();
    });
  }
  ctx.onDelete("clear-day", async () => {
    const n = await day.clearDay(db, date);
    if (n) flash(`Removed ${n} exercise${n === 1 ? "" : "s"} from this day.`);
    await refresh();
  });

  const setRow = (lx: LogEntry, s: LogSet, n: number) => html`
    <div class="log-row${s.completed_at ? " done" : ""}" data-set=${s.id} data-rest=${restAfter.has(s.id) ? "1" : "0"}>
      <span class="set-num">${n}</span>
      ${lx.exercise.modes.map((m) => {
        const f = FIELDS[m];
        // Planned targets (snapshotted when the workout was loaded) show as placeholders.
        let value: string;
        let target: string;
        if (m === "time") {
          value = formatDuration(s.duration_seconds);
          target = formatDuration(s.target_duration_seconds);
        } else if (m === "reps") {
          value = formatNumber(s.reps);
          target = s.target_label;
        } else {
          value = formatNumber(s[f.field] as number | null);
          target = formatNumber(m === "weight" ? s.target_weight : s.target_distance);
        }
        return html`<input type="text" inputmode=${f.inputmode} autocomplete="off" data-field=${f.field} .value=${value}
          placeholder=${target || (m === "time" ? "m:ss" : "–")}
          aria-label="Set ${n} ${f.label}${target ? `, target ${target}` : ""}">`;
      })}
      <button type="button" class="check" aria-pressed=${s.completed_at ? "true" : "false"} aria-label="Set ${n} completed">&#10003;</button>
    </div>`;

  // Superset toggle (user requirement): links this exercise with the one below it. Every card
  // but the day's last has one; it's pressed while the two are in the same superset.
  const supersetButton = (lx: LogEntry) => {
    const next = entries[entries.indexOf(lx) + 1];
    if (!next) return "";
    const linked = lx.superset_group !== null && lx.superset_group === next.superset_group;
    return html`<button type="button" class="button subtle small superset-btn" data-superset=${lx.id} aria-pressed=${linked ? "true" : "false"}
      aria-label=${linked ? `Unlink ${lx.exercise.name} from ${next.exercise.name}` : `Superset ${lx.exercise.name} with ${next.exercise.name}`}
      title=${linked ? "Unlink from the exercise below" : "Superset with the exercise below"}>${linkIcon} &darr;</button>`;
  };

  // Autoregulated sets show one rep target as the placeholder, so the ranges they move within are
  // shown under the Reps label: each distinct one in set order (8–15 when the plan had none, AMRAP).
  const repRangeNote = (lx: LogEntry) => {
    const ranges = [...new Set(lx.sets.filter((x) => x.target_reps !== null).map((x) => {
      if (x.target_amrap) return "AMRAP";
      const { min, max } = repRange({ reps_min: x.target_reps_min, reps_max: x.target_reps_max });
      return `${min}–${max}`;
    }))];
    return ranges.length ? html`<span class="rep-range">${ranges.join(" · ")}</span>` : "";
  };

  const card = (lx: LogEntry) => html`
    <section class="log-card" id="lx-${lx.id}" data-lx=${lx.id}>
      <div class="log-head">
        <div>
          <h2>${lx.exercise.name}</h2>
          ${lx.workout_name ? html`<span class="log-source">${lx.workout_name}</span>` : ""}
        </div>
        <div class="log-head-actions">
          <button type="button" class="button subtle small" data-history=${lx.exercise.id} data-name=${lx.exercise.name}>History</button>
          <button type="button" class="icon-btn danger" aria-label="Remove ${lx.exercise.name}"
                  data-confirm-delete="entry:${lx.id}" data-name=${lx.exercise.name}
                  data-detail="Removes it and its sets from this day.">&times;</button>
        </div>
      </div>
      ${lx.exercise.note || lx.note ? html`
        <div class="log-notes">
          ${lx.exercise.note ? html`<p class="note exercise-note"><span class="note-kind">Every time</span>${lx.exercise.note}</p>` : ""}
          ${lx.note ? html`<p class="note session-note"><span class="note-kind">This session</span>${lx.note}</p>` : ""}
        </div>` : ""}
      <div class="log-grid" style="--cols: ${lx.exercise.modes.length}">
        <div class="log-row log-labels" aria-hidden="true">
          <span>Set</span>${lx.exercise.modes.map((m) => html`<span>${FIELDS[m].label}${m === "reps" ? repRangeNote(lx) : ""}</span>`)}<span>Done</span>
        </div>
        ${lx.sets.map((s, i) => setRow(lx, s, i + 1))}
      </div>
      <div class="log-actions">
        <button type="button" class="button subtle small" data-act="add-set" data-lx=${lx.id}>+ Set</button>
        <button type="button" class="button subtle small" data-act="remove-set" data-lx=${lx.id} ?disabled=${lx.sets.length === 1}>&minus; Set</button>
        ${supersetButton(lx)}
        <button type="button" class="button subtle small notes-btn" data-notes=${lx.id} data-name=${lx.exercise.name}
                data-exercise-note=${lx.exercise.note ?? ""} data-session-note=${lx.note ?? ""}>Notes</button>
      </div>
    </section>`;

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return {
    title,
    section: "day" as const,
    screenClass: "has-timer",
    content: html`
      <div class="day" id="day" data-date=${date}>
        <header class="day-header">
          <a class="icon-btn day-nav" href="#/day/${prev}" aria-label="Previous day">&lsaquo;</a>
          <button type="button" class="day-title" id="open-calendar" aria-label="${title}, ${subtitle}. Open calendar">
            <span class="day-name">${title}</span>
            <span class="day-date">${subtitle} &#9662;</span>
          </button>
          <a class="icon-btn day-nav" href="#/day/${next}" aria-label="Next day">&rsaquo;</a>
        </header>
        ${isToday ? "" : html`<p class="jump-today"><a href="#/day">Jump to today</a></p>`}
        <div class="deload-row">
          <button type="button" class="button subtle small deload-btn" id="deload" aria-pressed=${deload ? "true" : "false"}>Deload day</button>
          ${deload ? html`<span class="hint">Autoregulation skips this day.</span>` : ""}
        </div>
        ${blocks.length ? html`
          ${blocks.length > 1 ? html`<p class="hint reorder-hint">Long-press an exercise to drag it into a new order.</p>` : ""}
          <div class="log-list" id="log-list">
            ${blocks.map((block) => html`
              <div class="log-block${block.length > 1 ? " superset" : ""}" data-block>
                ${block.length > 1 ? html`<span class="superset-tag">Superset</span>` : ""}
                ${block.map(card)}
              </div>`)}
          </div>` : html`
          <p class="empty">Nothing logged ${isToday ? "today" : "on this day"}.<br>Tap <strong>+ Add</strong> for a routine, workout or exercises.</p>`}
        <div class="day-actions">
          <button type="button" class="button block" id="open-add">+ Add</button>
          ${blocks.length ? html`
            <a class="button subtle block" href=${href("/workouts/new", { day: date, next: `#/day/${date}` })}>Build workout from day</a>
            <button type="button" class="button danger small clear-day" data-confirm-delete="clear-day"
                    data-title="Clear ${isToday ? "today" : "this day"}?"
                    data-detail="Removes all ${nExercises} exercise${nExercises === 1 ? "" : "s"} and their sets, including anything you’ve logged${deload ? ", and the deload mark" : ""}. This can’t be undone.">Clear day</button>` : ""}
        </div>
      </div>

      <dialog class="sheet add-sheet" id="add-sheet" aria-labelledby="add-sheet-title">
        <div class="sheet-head">
          <h2 id="add-sheet-title">Add to ${isToday ? "today" : "this day"}</h2>
          <button type="button" class="button subtle" data-close>Cancel</button>
        </div>
        <div class="segmented" role="tablist" aria-label="What to add">
          ${[["routines", "Routines"], ["workouts", "Workouts"], ["exercises", "Exercises"]].map(([key, label]) => html`
            <button type="button" role="tab" id="tab-${key}" aria-controls="panel-${key}" data-tab=${key}>${label}</button>`)}
        </div>
        <div class="tab-panel" role="tabpanel" id="panel-routines" aria-labelledby="tab-routines" hidden>
          ${routines.length ? html`
            <p class="hint">Tap a routine to preview its next workout. Tap &#8635; to pick a different one.</p>
            <ul class="picker-list">
              ${routines.map(({ routine: r, next: i }) => html`
                <li class="pick-item routine-pick" data-kind="routines" data-id=${r.id} data-index=${i} data-suggested=${i}
                    data-workouts=${JSON.stringify(r.workout_ids)}>
                  <div class="pick-row">
                    <button type="button" class="pick-toggle" aria-expanded="false" aria-controls="pick-routine-${r.id}">
                      <span>${r.name}<span class="picker-sub"><span data-pick-label>Next</span>: <span data-pick-name>${workoutNames.get(r.workout_ids[i])}</span></span></span>
                      <span class="picker-meta" data-pick-pos>${i + 1} of ${r.workout_ids.length}</span>
                      <span class="chev" aria-hidden="true">&#9662;</span>
                    </button>
                    ${r.workout_ids.length > 1 ? html`
                      <button type="button" class="icon-btn cycle-btn" data-cycle aria-label="Pick a different workout from ${r.name}">&#8635;</button>` : ""}
                  </div>
                  <div class="pick-detail" id="pick-routine-${r.id}" hidden>
                    <ol class="workout-summary" data-summary></ol>
                    <button type="button" class="button block" data-load>Load ${workoutNames.get(r.workout_ids[i])}</button>
                  </div>
                </li>`)}
            </ul>` : html`<p class="empty small">No routines yet. <a href="#/routines/new">Make one</a>.</p>`}
        </div>
        <div class="tab-panel" role="tabpanel" id="panel-workouts" aria-labelledby="tab-workouts" hidden>
          ${workouts.length ? html`
            <ul class="picker-list">
              ${workouts.map((w) => html`
                <li class="pick-item" data-kind="workouts" data-id=${w.id} data-workouts=${JSON.stringify([w.id])} data-index="0">
                  <div class="pick-row">
                    <button type="button" class="pick-toggle" aria-expanded="false" aria-controls="pick-workout-${w.id}">
                      <span>${w.name}</span>
                      <span class="picker-meta">${plural(w.slots.length, "exercise")}</span>
                      <span class="chev" aria-hidden="true">&#9662;</span>
                    </button>
                  </div>
                  <div class="pick-detail" id="pick-workout-${w.id}" hidden>
                    <ol class="workout-summary" data-summary></ol>
                    <button type="button" class="button block" data-load>Load workout</button>
                  </div>
                </li>`)}
            </ul>` : html`<p class="empty small">No workouts yet. <a href="#/workouts/new">Build one first</a>.</p>`}
        </div>
        <div class="tab-panel" role="tabpanel" id="panel-exercises" aria-labelledby="tab-exercises" hidden>
          ${options.length ? html`
            ${filterControls(muscles)}
            <ul class="picker-list multi" id="exercise-list"></ul>
            <p class="empty small" id="exercise-none" hidden>No matches.</p>
            <button type="button" class="button block" id="add-exercises" disabled>Select exercises</button>` : html`
            <p class="empty small">No exercises yet. <a href="#/exercises/new">Create one first</a>.</p>`}
        </div>
      </dialog>

      <dialog class="sheet notes-sheet" id="notes-sheet" aria-labelledby="notes-sheet-title">
        <div class="sheet-head">
          <h2 id="notes-sheet-title"></h2>
          <button type="button" class="button subtle" data-close>Cancel</button>
        </div>
        <form class="form" id="notes-form">
          <div class="field">
            <label for="exercise-note">Every time</label>
            <p class="hint">Shown whenever you do this exercise.</p>
            <textarea id="exercise-note" rows="3" maxlength=${NOTE_MAX_LENGTH}></textarea>
          </div>
          <div class="field">
            <label for="session-note">This session</label>
            <p class="hint">Only for ${dayLabel}. Kept in the exercise’s history.</p>
            <textarea id="session-note" rows="3" maxlength=${NOTE_MAX_LENGTH}></textarea>
          </div>
          <button type="submit" class="button block">Save notes</button>
        </form>
      </dialog>

      <dialog class="sheet history-sheet" id="history-sheet" aria-labelledby="history-sheet-title">
        <div class="sheet-head">
          <div>
            <h2 id="history-sheet-title"></h2>
            <p class="hint">Before ${dayLabel}</p>
          </div>
          <button type="button" class="button" data-close>Done</button>
        </div>
        <div class="history-body" id="history-body" aria-live="polite"></div>
      </dialog>

      <dialog class="sheet" id="calendar-sheet" aria-labelledby="cal-title">
        <div class="cal-head">
          <button type="button" class="icon-btn" data-month="-1" aria-label="Previous month">&lsaquo;</button>
          <h2 id="cal-title"></h2>
          <button type="button" class="icon-btn" data-month="1" aria-label="Next month">&rsaquo;</button>
        </div>
        <div class="cal-grid" id="cal-grid"></div>
        <p class="cal-legend"><span class="dot partial"></span> Logged <span class="dot complete"></span> All sets done</p>
        <div class="sheet-actions">
          <button type="button" class="button subtle block" data-close>Close</button>
          <a class="button block" href="#/day">Today</a>
        </div>
      </dialog>

      ${restTimerSheet()}
      ${restTimerBar()}
      <div class="toast" id="toast" role="status" hidden></div>`,
    mount(root: HTMLElement, signal: AbortSignal) {
      const timer = mountRestTimer(root, signal);
      mountDay(root, signal, ctx, { date, prev, next, options, summaries, onSetCompleted: timer.onSetCompleted });
    },
  };
}

// Direction of the last swipe/arrow navigation, so the next day slides in from that side.
let enterFrom: "next" | "prev" | null = null;

type Summaries = Record<number, { name: string; blocks: { name: string; sets: number }[][] }>;

function mountDay(
  root: HTMLElement, signal: AbortSignal, ctx: Ctx,
  o: { date: string; prev: string; next: string; options: PickerOption[]; summaries: Summaries; onSetCompleted: () => void },
) {
  const { db } = ctx;
  const dayEl = root.querySelector<HTMLElement>("#day")!;
  const toastEl = root.querySelector<HTMLElement>("#toast")!;
  const on = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K | string, fn: (e: any) => void, extra: AddEventListenerOptions = {}) =>
    el.addEventListener(type, fn, { signal, ...extra });
  const esc = (s: unknown) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

  let toastTimer: number | undefined;
  function toast(message: string) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), 3500);
  }
  signal.addEventListener("abort", () => clearTimeout(toastTimer));

  // ---------- set fields: autosave on change; ✓ saves the whole row ----------

  function readField(input: HTMLInputElement): number | null {
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
  function showField(input: HTMLInputElement, value: number | null) {
    if (value == null) input.value = "";
    else if (input.dataset.field === "duration_seconds") input.value = formatTime(value);
    else input.value = String(value);
  }
  function applySet(row: HTMLElement, data: ReturnType<typeof day.setState>) {
    for (const input of row.querySelectorAll<HTMLInputElement>("input[data-field]")) {
      if (document.activeElement !== input) showField(input, (data as any)[input.dataset.field!]);
      input.classList.remove("invalid");
    }
    row.classList.toggle("done", data.completed);
    row.querySelector(".check")!.setAttribute("aria-pressed", String(data.completed));
  }

  on(dayEl, "change", async (e: Event) => {
    const input = (e.target as Element).closest<HTMLInputElement>("input[data-field]");
    if (!input) return;
    const row = input.closest<HTMLElement>("[data-set]")!;
    let value: number | null;
    try {
      value = readField(input);
    } catch (err) {
      input.classList.add("invalid");
      return toast((err as Error).message);
    }
    try {
      const data = await day.updateSet(db, Number(row.dataset.set), { [input.dataset.field!]: value });
      showField(input, (data as any)[input.dataset.field!]);
      input.classList.remove("invalid");
    } catch (err) {
      input.classList.add("invalid");
      toast((err as Error).message);
    }
  });

  // ---------- autofill (user requirement) ----------
  // The first weight or reps value entered for an exercise is copied, as you type, into that
  // column on its later sets that are empty and not checked off, and saved with it. After that
  // the column counts as filled and every set is edited on its own. A column that already has a
  // value anywhere (e.g. after a reload) is filled from the start.
  const AUTOFILL = ["weight", "reps"];
  const filled = new Set<string>(); // `${lx}:${field}`
  for (const input of dayEl.querySelectorAll<HTMLInputElement>("input[data-field]")) {
    if (input.value) filled.add(`${input.closest<HTMLElement>("[data-lx]")!.dataset.lx}:${input.dataset.field}`);
  }
  let mirror: { source: HTMLInputElement; targets: HTMLInputElement[] } | null = null;
  const fieldKey = (input: HTMLInputElement) => `${input.closest<HTMLElement>("[data-lx]")!.dataset.lx}:${input.dataset.field}`;

  on(dayEl, "input", (e: Event) => {
    const input = (e.target as Element).closest<HTMLInputElement>("input[data-field]");
    if (!input || !AUTOFILL.includes(input.dataset.field!) || filled.has(fieldKey(input))) return;
    if (mirror?.source !== input) {
      const rows = [...input.closest("[data-lx]")!.querySelectorAll<HTMLElement>("[data-set]")];
      const later = rows.slice(rows.indexOf(input.closest<HTMLElement>("[data-set]")!) + 1);
      mirror = {
        source: input,
        targets: later.filter((r) => !r.classList.contains("done"))
          .map((r) => r.querySelector<HTMLInputElement>(`input[data-field="${input.dataset.field}"]`)!)
          .filter((t) => !t.value),
      };
    }
    for (const t of mirror.targets) t.value = input.value;
  });

  on(dayEl, "change", async (e: Event) => {
    const input = (e.target as Element).closest<HTMLInputElement>("input[data-field]");
    if (!input || mirror?.source !== input) return;
    const { targets } = mirror;
    mirror = null;
    let value: number | null;
    try {
      value = readField(input);
    } catch {
      for (const t of targets) t.value = ""; // the source shows the error; don't spread a bad value
      return;
    }
    if (value == null) return;
    filled.add(fieldKey(input));
    for (const t of targets) {
      try {
        const data = await day.updateSet(db, Number(t.closest<HTMLElement>("[data-set]")!.dataset.set), { [t.dataset.field!]: value });
        showField(t, (data as any)[t.dataset.field!]);
      } catch (err) {
        t.classList.add("invalid");
        toast((err as Error).message);
      }
    }
  });

  on(dayEl, "click", async (e: Event) => {
    const check = (e.target as Element).closest<HTMLButtonElement>(".check");
    if (!check) return;
    const row = check.closest<HTMLElement>("[data-set]")!;
    const completed = check.getAttribute("aria-pressed") !== "true";
    const body: Record<string, unknown> = { completed };
    try {
      for (const input of row.querySelectorAll<HTMLInputElement>("input[data-field]")) body[input.dataset.field!] = readField(input);
    } catch (err) {
      return toast((err as Error).message);
    }
    check.disabled = true;
    try {
      const data = await day.updateSet(db, Number(row.dataset.set), body);
      applySet(row, data);
      if (data.completed) tapHaptic();
      if (data.completed && row.dataset.rest === "1") o.onSetCompleted();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      check.disabled = false;
    }
  });

  // ---------- deload day (autoregulation ignores it as a reference) ----------
  on(dayEl, "click", async (e: Event) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("#deload");
    if (!btn) return;
    btn.disabled = true;
    try {
      await setDeload(db, o.date, btn.getAttribute("aria-pressed") !== "true");
      await refresh();
    } catch (err) {
      toast((err as Error).message);
      btn.disabled = false;
    }
  });

  // ---------- superset with the exercise below ----------
  on(dayEl, "click", async (e: Event) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("[data-superset]");
    if (!btn) return;
    btn.disabled = true;
    try {
      await day.setSupersetWithNext(db, Number(btn.dataset.superset), btn.getAttribute("aria-pressed") !== "true");
      await refresh();
    } catch (err) {
      toast((err as Error).message);
      btn.disabled = false;
    }
  });

  // ---------- add / remove sets ----------
  on(dayEl, "click", async (e: Event) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("[data-act]");
    if (!btn || (btn.dataset.act !== "add-set" && btn.dataset.act !== "remove-set")) return;
    btn.disabled = true;
    try {
      if (btn.dataset.act === "add-set") await day.addLogSet(db, Number(btn.dataset.lx));
      else await day.removeLastLogSet(db, Number(btn.dataset.lx));
      await refresh();
    } catch (err) {
      toast((err as Error).message);
      btn.disabled = false;
    }
  });

  // ---------- sheets ----------
  const wireSheet = (sheet: HTMLDialogElement) =>
    on(sheet, "click", (e: Event) => {
      if (e.target === sheet || (e.target as Element).closest("[data-close]")) sheet.close();
    });

  // "+ Add": Routines / Workouts / Exercises tabs. Routines and workouts expand to a preview with
  // a Load button; exercises are multi-select, added in pick order.
  const addSheet = root.querySelector<HTMLDialogElement>("#add-sheet")!;
  const tabs = [...addSheet.querySelectorAll<HTMLElement>("[data-tab]")];
  const TAB_KEY = "fitapp.addTab";
  wireSheet(addSheet);

  function showTab(key: string) {
    for (const tab of tabs) {
      const onTab = tab.dataset.tab === key;
      tab.setAttribute("aria-selected", String(onTab));
      tab.tabIndex = onTab ? 0 : -1;
      addSheet.querySelector<HTMLElement>(`#panel-${tab.dataset.tab}`)!.hidden = !onTab;
    }
    try {
      localStorage.setItem(TAB_KEY, key);
    } catch {
      /* remembering the tab is a convenience only */
    }
  }
  on(addSheet, "click", (e: Event) => {
    const tab = (e.target as Element).closest<HTMLElement>("[data-tab]");
    if (tab) showTab(tab.dataset.tab!);
  });
  on(addSheet.querySelector(".segmented")!, "keydown", (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    const nextTab = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    showTab(nextTab.dataset.tab!);
    nextTab.focus();
  });

  const exList = root.querySelector<HTMLElement>("#exercise-list");
  const filterRoot = addSheet.querySelector<HTMLElement>("[data-exercise-filter]");
  const exFilter = filterRoot ? exerciseFilter(filterRoot, renderExercisePicker, signal) : null;
  const exNone = root.querySelector<HTMLElement>("#exercise-none");
  const exAdd = root.querySelector<HTMLButtonElement>("#add-exercises");
  const selected: number[] = []; // exercise ids, in the order they were picked

  on(root.querySelector("#open-add")!, "click", () => {
    let key: string | null = null;
    try {
      key = localStorage.getItem(TAB_KEY);
    } catch {
      /* ignore */
    }
    if (!tabs.some((t) => t.dataset.tab === key)) key = "routines";
    selected.length = 0;
    exFilter?.reset();
    renderExercisePicker();
    for (const item of addSheet.querySelectorAll<HTMLElement>(".pick-item.expanded")) setExpanded(item, false);
    showTab(key!);
    addSheet.showModal();
  });

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  function renderSummary(item: HTMLElement) {
    const w = o.summaries[JSON.parse(item.dataset.workouts!)[Number(item.dataset.index)]];
    const line = (ex: { name: string; sets: number }) =>
      `<li><span>${esc(ex.name)}</span><span class="set-summary">${plural(ex.sets, "set")}</span></li>`;
    item.querySelector("[data-summary]")!.innerHTML = w.blocks
      .map((block) => block.length > 1
        ? `<li class="superset-block"><span class="superset-tag">Superset</span><ol>${block.map(line).join("")}</ol></li>`
        : line(block[0]))
      .join("");
    if (item.dataset.kind === "routines") item.querySelector("[data-load]")!.textContent = `Load ${w.name}`;
  }
  function setExpanded(item: HTMLElement, open: boolean) {
    item.querySelector(".pick-toggle")!.setAttribute("aria-expanded", String(open));
    item.querySelector<HTMLElement>(".pick-detail")!.hidden = !open;
    item.classList.toggle("expanded", open);
    if (open) renderSummary(item);
  }
  function expand(item: HTMLElement) {
    for (const other of addSheet.querySelectorAll<HTMLElement>(".pick-item.expanded")) if (other !== item) setExpanded(other, false);
    setExpanded(item, true);
  }
  on(addSheet, "click", (e: Event) => {
    const toggle = (e.target as Element).closest(".pick-toggle");
    if (!toggle) return;
    const item = toggle.closest<HTMLElement>(".pick-item")!;
    if (item.classList.contains("expanded")) setExpanded(item, false);
    else expand(item);
  });
  on(addSheet, "click", (e: Event) => {
    const cycle = (e.target as Element).closest("[data-cycle]");
    if (!cycle) return;
    const item = cycle.closest<HTMLElement>(".pick-item")!;
    const ids: number[] = JSON.parse(item.dataset.workouts!);
    const index = (Number(item.dataset.index) + 1) % ids.length;
    const overridden = index !== Number(item.dataset.suggested);
    item.dataset.index = String(index);
    item.classList.toggle("overridden", overridden);
    item.querySelector("[data-pick-label]")!.textContent = overridden ? "Picked" : "Next";
    item.querySelector("[data-pick-name]")!.textContent = o.summaries[ids[index]].name;
    item.querySelector("[data-pick-pos]")!.textContent = `${index + 1} of ${ids.length}`;
    expand(item); // show what was picked
  });
  on(addSheet, "click", async (e: Event) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("[data-load]");
    if (!btn) return;
    const item = btn.closest<HTMLElement>(".pick-item")!;
    const id = Number(item.dataset.id);
    btn.disabled = true;
    try {
      if (item.dataset.kind === "routines") await day.loadRoutine(db, o.date, id, Number(item.dataset.index));
      else await day.loadWorkout(db, o.date, id);
      addSheet.close();
      await refresh();
    } catch (err) {
      btn.disabled = false;
      toast((err as Error).message);
    }
  });

  function renderExercisePicker() {
    if (!exList || !exFilter) return;
    const matches = o.options.filter(exFilter.matches);
    exList.innerHTML = matches.map((opt) => {
      const n = selected.indexOf(opt.id) + 1;
      const modes = opt.modes.map((m) => m[0].toUpperCase() + m.slice(1)).join(" · ");
      return `<li><button type="button" role="checkbox" aria-checked="${n > 0}" data-exercise-id="${opt.id}">
        <span class="pick-box" aria-hidden="true">${n || ""}</span>
        <span class="pick-name">${esc(opt.name)}</span>
        <span class="picker-meta">${esc(modes)}</span></button></li>`;
    }).join("");
    exNone!.hidden = matches.length > 0;
    exAdd!.disabled = selected.length === 0;
    exAdd!.textContent = selected.length ? `Add ${plural(selected.length, "exercise")}` : "Select exercises";
  }
  if (exList && exAdd) {
    on(exList, "click", (e: Event) => {
      const btn = (e.target as Element).closest<HTMLElement>("[data-exercise-id]");
      if (!btn) return;
      const id = Number(btn.dataset.exerciseId);
      const i = selected.indexOf(id);
      if (i >= 0) selected.splice(i, 1);
      else selected.push(id);
      renderExercisePicker();
      exList.querySelector<HTMLElement>(`[data-exercise-id="${id}"]`)?.focus();
    });
    on(exAdd, "click", async () => {
      exAdd.disabled = true;
      try {
        await day.addExercises(db, o.date, [...selected]);
        addSheet.close();
        await refresh();
      } catch (err) {
        exAdd.disabled = false;
        toast((err as Error).message);
      }
    });
  }

  // ---------- history sheet: this exercise's sessions before this day ----------
  const historySheet = root.querySelector<HTMLDialogElement>("#history-sheet")!;
  const historyBody = root.querySelector<HTMLElement>("#history-body")!;
  wireSheet(historySheet);
  on(dayEl, "click", async (e: Event) => {
    const btn = (e.target as Element).closest<HTMLElement>("[data-history]");
    if (!btn) return;
    root.querySelector("#history-sheet-title")!.textContent = btn.dataset.name!;
    try {
      const exercise = await getExercise(db, Number(btn.dataset.history));
      render(historyList(exercise, await exerciseHistory(db, exercise, o.date), ctx.today), historyBody);
      historySheet.showModal();
    } catch (err) {
      toast((err as Error).message);
    }
  });

  // ---------- notes sheet ----------
  const notesSheet = root.querySelector<HTMLDialogElement>("#notes-sheet")!;
  const notesForm = root.querySelector<HTMLFormElement>("#notes-form")!;
  const exerciseNote = root.querySelector<HTMLTextAreaElement>("#exercise-note")!;
  const sessionNote = root.querySelector<HTMLTextAreaElement>("#session-note")!;
  let notesFor: number | null = null;
  wireSheet(notesSheet);
  on(dayEl, "click", (e: Event) => {
    const btn = (e.target as Element).closest<HTMLElement>("[data-notes]");
    if (!btn) return;
    notesFor = Number(btn.dataset.notes);
    root.querySelector("#notes-sheet-title")!.textContent = btn.dataset.name!;
    exerciseNote.value = btn.dataset.exerciseNote!;
    sessionNote.value = btn.dataset.sessionNote!;
    notesSheet.showModal();
    (btn.dataset.sessionNote || !btn.dataset.exerciseNote ? sessionNote : exerciseNote).focus();
  });
  on(notesForm, "submit", async (e: Event) => {
    e.preventDefault();
    const submit = notesForm.querySelector<HTMLButtonElement>("[type=submit]")!;
    submit.disabled = true;
    try {
      await day.updateNotes(db, notesFor!, { exercise_note: exerciseNote.value, session_note: sessionNote.value });
      notesSheet.close();
      await refresh();
    } catch (err) {
      submit.disabled = false;
      toast((err as Error).message);
    }
  });

  // ---------- long-press to reorder (ui/dragReorder.ts) ----------
  // A superset moves as one block. While dragging, every card collapses to its name (user
  // requirement) so blocks are short and easy to move; they expand again on drop.
  const logList = root.querySelector<HTMLElement>("#log-list");
  let touch: { x: number; y: number; t: number } | null = null;
  async function saveOrder() {
    const ids = [...logList!.querySelectorAll<HTMLElement>(".log-card")].map((c) => Number(c.dataset.lx));
    try {
      await day.reorderDay(db, o.date, ids);
    } catch (err) {
      toast((err as Error).message);
      setTimeout(() => void refresh(), 1500);
    }
  }
  const reorder = logList ? longPressReorder(logList, {
    signal,
    items: () => [...logList.querySelectorAll<HTMLElement>(":scope > [data-block]")],
    bottomInset: 72, // the rest timer bar and tab bar
    onLift() {
      touch = null; // cancel any day swipe in progress
      dayEl.style.transform = "";
      logList.classList.add("collapsed");
    },
    onDrop(from, to, block) {
      const blocks = [...logList.querySelectorAll<HTMLElement>(":scope > [data-block]")];
      if (to > from) blocks[to].after(block);
      else if (to < from) blocks[to].before(block);
      // Expand the cards again, keeping the dropped block where it is on screen.
      const before = block.getBoundingClientRect().top;
      logList.classList.remove("collapsed");
      scrollBy(0, block.getBoundingClientRect().top - before);
      if (to !== from) void saveOrder();
    },
  }) : null;

  // ---------- calendar ----------
  const calSheet = root.querySelector<HTMLDialogElement>("#calendar-sheet")!;
  const calTitle = root.querySelector<HTMLElement>("#cal-title")!;
  const calGrid = root.querySelector<HTMLElement>("#cal-grid")!;
  wireSheet(calSheet);
  const pad = (n: number) => String(n).padStart(2, "0");
  const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const [selY, selM] = o.date.split("-").map(Number);
  let calYear = selY;
  let calMonth = selM - 1; // 0-based
  let calRequest = 0;

  async function renderCalendar() {
    const request = ++calRequest;
    const first = new Date(calYear, calMonth, 1);
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    calTitle.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    let counts: Record<string, { sets: number; done: number }> = {};
    try {
      counts = await day.calendarCounts(db, `${calYear}-${pad(calMonth + 1)}`);
    } catch (err) {
      toast((err as Error).message);
    }
    if (request !== calRequest) return; // a newer month was requested meanwhile
    const cells = ["S", "M", "T", "W", "T", "F", "S"].map((d) => `<span class="cal-dow" aria-hidden="true">${d}</span>`);
    for (let i = 0; i < first.getDay(); i++) cells.push("<span></span>");
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = isoOf(calYear, calMonth, d);
      const c = counts[iso];
      const classes = ["cal-day"];
      if (iso === ctx.today) classes.push("today");
      if (iso === o.date) classes.push("selected");
      let status = "";
      if (c) {
        const complete = c.sets > 0 && c.done === c.sets;
        classes.push(complete ? "complete" : "partial");
        status = complete ? ", all sets done" : `, ${c.done} of ${c.sets} sets done`;
      }
      const label = new Date(calYear, calMonth, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      cells.push(`<a class="${classes.join(" ")}" href="#/day/${iso}" aria-label="${esc(label + status)}"
        ${iso === o.date ? 'aria-current="date"' : ""}>${d}</a>`);
    }
    calGrid.innerHTML = cells.join("");
  }
  on(root.querySelector("#open-calendar")!, "click", () => {
    calYear = selY;
    calMonth = selM - 1;
    void renderCalendar();
    calSheet.showModal();
  });
  on(calSheet, "click", (e: Event) => {
    const t = e.target as Element;
    if (t.closest(".cal-day")) return calSheet.close(); // navigating away
    const btn = t.closest<HTMLElement>("[data-month]");
    if (!btn) return;
    calMonth += Number(btn.dataset.month);
    if (calMonth < 0) (calMonth = 11), calYear--;
    if (calMonth > 11) (calMonth = 0), calYear++;
    void renderCalendar();
  });

  // ---------- swipe / arrow-key day navigation ----------
  function go(direction: "next" | "prev") {
    // "next": content leaves to the left; "prev": leaves to the right.
    enterFrom = direction;
    dayEl.classList.add(direction === "next" ? "leave-left" : "leave-right");
    setTimeout(() => navigate(`#/day/${direction === "next" ? o.next : o.prev}`), 140);
  }
  if (enterFrom) dayEl.classList.add(enterFrom === "next" ? "enter-from-right" : "enter-from-left");
  enterFrom = null;

  on(dayEl, "touchstart", (e: TouchEvent) => {
    if (e.touches.length !== 1 || (e.target as Element).closest("input")) return (touch = null);
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  on(dayEl, "touchmove", (e: TouchEvent) => {
    if (!touch || reorder?.isDragging()) return;
    const dx = e.touches[0].clientX - touch.x;
    const dy = e.touches[0].clientY - touch.y;
    if (Math.abs(dx) > Math.abs(dy)) dayEl.style.transform = `translateX(${dx * 0.4}px)`;
  }, { passive: true });
  on(dayEl, "touchend", (e: TouchEvent) => {
    dayEl.style.transform = "";
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    const quick = Date.now() - touch.t < 800;
    touch = null;
    if (quick && Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) go(dx < 0 ? "next" : "prev");
  });
  on(dayEl, "touchcancel", () => {
    dayEl.style.transform = "";
    touch = null;
  });
  on(document, "keydown", (e: KeyboardEvent) => {
    if ((e.target as Element).closest("input, textarea") || document.querySelector("dialog[open]")) return;
    if (e.key === "ArrowLeft") go("prev");
    if (e.key === "ArrowRight") go("next");
  });
}
