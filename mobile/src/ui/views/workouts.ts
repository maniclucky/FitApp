// Workouts: the list and the workout builder. Ported from templates/workouts.html,
// workout_builder.html and static/workout_builder.js.
import { html, nothing } from "lit-html";
import { dayEntries, dayToWorkoutItems } from "../../logic/day";
import { exercisePickerData, type PickerOption } from "../../logic/exercises";
import {
  deleteWorkout, getWorkout, groupBlocks, type Item, listWorkouts, saveWorkout, slotSummary, type Workout, workoutDeleteBlocker,
  workoutToItems,
} from "../../logic/workouts";
import { type Ctx, currentPath, flash, href, navigate, refresh, returnTo, route, stash, takeStash } from "../app";
import { cardCopyButton, copyName } from "../copy";
import { longPressReorder } from "../dragReorder";
import { exerciseFilter, filterControls } from "../exerciseFilter";
import { formatTime, parseTime } from "../time";
import { takeCreatedExercises } from "./exercises";

const DELETE_DETAIL = "This permanently removes the workout plan. Days you’ve already logged keep their sets.";

function registerDelete(ctx: Ctx, w: { id: number }, then: string) {
  ctx.onDelete(`workout:${w.id}`, async () => {
    const name = await deleteWorkout(ctx.db, w.id);
    flash(`Deleted “${name}”.`);
    navigate(then);
  });
}

export function workoutSummaryList(w: Workout) {
  return html`
    <ol class="workout-summary">
      ${groupBlocks(w.slots).map((block) => block.length > 1
        ? html`<li class="superset-block"><span class="superset-tag">Superset</span><ol>
            ${block.map((wx) => html`<li><span>${wx.exercise.name}</span><span class="set-summary">${slotSummary(wx)}</span></li>`)}
          </ol></li>`
        : html`<li><span>${block[0].exercise.name}</span><span class="set-summary">${slotSummary(block[0])}</span></li>`)}
    </ol>`;
}

route(/^\/workouts$/, async (ctx) => {
  const workouts = await listWorkouts(ctx.db);
  const blocked = new Map(await Promise.all(workouts.map(async (w) => [w.id, await workoutDeleteBlocker(ctx.db, w.id)] as const)));
  for (const w of workouts) registerDelete(ctx, w, "#/workouts");
  return {
    title: "Workouts",
    section: "workouts",
    content: html`
      <header class="page-header">
        <h1>Workouts</h1>
        <a class="button" href="#/workouts/new">+ New</a>
      </header>
      ${workouts.length ? html`
        <ul class="card-list">
          ${workouts.map((w) => html`
            <li class="card-wrap">
              <a class="card card-link" href="#/workouts/${w.id}"><h2>${w.name}</h2>${workoutSummaryList(w)}</a>
              ${cardCopyButton("workouts", w.id, w.name)}
              <button type="button" class="icon-btn danger card-delete" aria-label="Delete ${w.name}"
                      data-confirm-delete="workout:${w.id}" data-name=${w.name} data-detail=${DELETE_DETAIL}
                      data-blocked=${blocked.get(w.id) ?? nothing}>&times;</button>
            </li>`)}
        </ul>` : html`<p class="empty">No workouts yet. Tap <strong>+ New</strong> to build one.</p>`}`,
  };
});

route(/^\/workouts\/new$/, (ctx) => builder(ctx, null));
route(/^\/workouts\/(\d+)$/, async (ctx) => builder(ctx, await getWorkout(ctx.db, Number(ctx.params[0]))));

type BuilderStash = { errors: string[]; name: string; items: Item[] };
// Unsaved builder state kept while "+ New exercise" visits the exercise form, keyed by the
// builder's own route; restored (with the new exercises added) when it comes back.
type Draft = { name: string; items: EditItem[] };
const drafts = new Map<string, Draft>();

/** Where Back and Save go: ?next= (e.g. from a routine card) or the workouts list. Same-app routes only. */
function backTarget(ctx: Ctx) {
  const next = ctx.query.get("next");
  return next && next.startsWith("#/") ? next : "#/workouts";
}

async function builder(ctx: Ctx, workout: Workout | null) {
  const back = backTarget(ctx);
  const here = `#${currentPath()}`;
  const newExercise = href("/exercises/new", { next: here });
  const stashed = takeStash<BuilderStash>();
  const copyId = Number(ctx.query.get("copy"));
  const source = workout ?? (copyId ? await getWorkout(ctx.db, copyId) : null);
  const name = stashed?.name ?? (workout ? workout.name : source ? copyName(source.name) : "");
  // ?day=<date>: "Build workout from day" — the day's exercises, blank targets, blank name.
  const fromDay = !workout && !source && ctx.query.get("day");
  const items = stashed?.items ?? (source ? workoutToItems(source) : fromDay ? dayToWorkoutItems(await dayEntries(ctx.db, fromDay)) : []);
  const errors = stashed?.errors ?? [];
  const { options, muscles } = await exercisePickerData(ctx.db);
  const blocked = workout ? await workoutDeleteBlocker(ctx.db, workout.id) : null;
  if (workout) registerDelete(ctx, workout, "#/workouts");

  return {
    title: workout ? "Edit workout" : "New workout",
    tabbar: false,
    content: html`
      <header class="page-header">
        <a class="back" href=${back} aria-label="Back">&larr;</a>
        <h1>${workout ? "Edit workout" : "New workout"}</h1>
        <button type="button" class="button subtle" id="open-picker">+ Add</button>
        <button type="submit" class="button" form="builder-form">Save</button>
      </header>
      ${errors.length ? html`<div class="errors" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ""}
      <form class="form" id="builder-form" novalidate>
        <div class="field">
          <label for="name">Name</label>
          <input id="name" name="name" type="text" maxlength="100" required autocomplete="off" autocapitalize="words" placeholder="e.g. Push Day" .value=${name}>
        </div>
        <div class="field">
          <span class="field-label">Exercises</span>
          <p class="hint reorder-hint" id="builder-hint" hidden>Long-press an exercise to drag it into a new order.</p>
          <ol class="builder-list" id="builder-list"></ol>
          <p class="empty small" id="builder-empty">No exercises yet. Tap <strong>+ Add</strong> to pick some.</p>
        </div>
      </form>
      ${workout ? html`
        <button type="button" class="button danger block delete-trigger"
                data-confirm-delete="workout:${workout.id}" data-name=${workout.name} data-detail=${DELETE_DETAIL}
                data-blocked=${blocked ?? nothing}>Delete workout</button>` : ""}
      <dialog class="sheet" id="picker" aria-labelledby="picker-title">
        <div class="sheet-head">
          <h2 id="picker-title">Add exercises</h2>
          <a class="button subtle" href=${newExercise} data-leave>+ New</a>
          <button type="button" class="button" id="close-picker">Done</button>
        </div>
        ${options.length ? html`
          ${filterControls(muscles)}
          <ul class="picker-list" id="picker-list"></ul>
          <p class="empty small" id="picker-none" hidden>No matches.</p>` : html`
          <p class="empty small">You haven't created any exercises yet. <a href=${newExercise} data-leave>Create one first</a>.</p>`}
      </dialog>`,
    mount(root: HTMLElement, signal: AbortSignal) {
      mountBuilder(root, signal, options, items, here, async (rawName, finalItems) => {
        const result = await saveWorkout(ctx.db, workout?.id ?? null, rawName, finalItems);
        if (result.ok) {
          flash(`Saved “${result.name}”.`);
          returnTo(back);
        } else {
          stash({ errors: result.errors, name: result.name, items: result.items } satisfies BuilderStash);
          await refresh();
          window.scrollTo(0, 0);
        }
      });
    },
  };
}

// ---------- the builder (static/workout_builder.js) ----------
//
// The workout lives in `items` and is re-rendered on structural changes. Typing in set fields
// updates state in place so focus isn't lost.
//   items: [{ exercise_id, superset_next, sets: [{ min, max, amrap, weight, time, distance }] }]
// superset_next links an exercise to the one after it (chains allowed). Each set has a field per
// mode the exercise tracks: a rep range (+ AMRAP), weight (lb), time, distance (mi). Weight/time/
// distance are kept as the text typed and parsed on save; time accepts "1:30" or "130".
//
// Autofill: the first value typed into a column (min, max, weight, time, distance) is mirrored into
// that column on the exercise's other sets as you type (rep columns skip AMRAP sets). Once that field
// is committed (blur), the column is "filled" and later edits stay put.

const DEFAULT_SET_COUNT = 3;
const FIELDS = ["min", "max", "weight", "time", "distance"] as const;
const TEXT_FIELDS = ["weight", "time", "distance"];
type Field = (typeof FIELDS)[number];
type EditSet = { min: number | null; max: number | null; amrap: boolean; weight: string | null; time: string | null; distance: string | null };
type EditItem = { exercise_id: number; superset_next: boolean; sets: EditSet[]; filled: Record<Field, boolean> };

function mountBuilder(
  root: HTMLElement, signal: AbortSignal, options: PickerOption[], initial: Item[], draftKey: string,
  onSave: (name: string, items: EditItem[]) => Promise<void>,
) {
  const byId = new Map(options.map((o) => [o.id, o]));
  // Saved values are numbers (time in seconds); the builder edits them as text.
  const asText = (field: string, v: unknown) =>
    v == null || v === "" ? null : field === "time" && typeof v === "number" ? formatTime(v) : String(v);
  const items: EditItem[] = initial.filter((it) => byId.has(it.exercise_id)).map((it) => {
    const sets = it.sets.map((st) => ({
      min: st.min, max: st.max, amrap: st.amrap, weight: asText("weight", st.weight), time: asText("time", st.time),
      distance: asText("distance", st.distance),
    }));
    // Loaded workouts (edit / failed save): a column that already has values counts as filled.
    const filled = Object.fromEntries(FIELDS.map((f) => [f, sets.some((st) => st[f] != null)])) as Record<Field, boolean>;
    return { exercise_id: it.exercise_id, superset_next: it.superset_next, sets, filled };
  });

  const list = root.querySelector<HTMLElement>("#builder-list")!;
  const empty = root.querySelector<HTMLElement>("#builder-empty")!;
  const hint = root.querySelector<HTMLElement>("#builder-hint")!;
  const picker = root.querySelector<HTMLDialogElement>("#picker")!;
  const esc = (s: unknown) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const modesOf = (item: EditItem) => byId.get(item.exercise_id)!.modes;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  // One grid column per tracked mode, in TRACKING_MODES order (like the day view).
  const COLUMNS: Record<string, { tracks: string; heads: string[] }> = {
    weight: { tracks: "minmax(0, 1fr)", heads: ["lb"] },
    reps: { tracks: "minmax(0, 2fr) auto", heads: ["Reps", ""] },
    time: { tracks: "minmax(0, 1fr)", heads: ["Time"] },
    distance: { tracks: "minmax(0, 1fr)", heads: ["mi"] },
  };
  const gridColumns = (item: EditItem) => ["28px", ...modesOf(item).map((m) => COLUMNS[m].tracks), "40px"].join(" ");
  const timeInvalid = (set: EditSet) => set.time != null && Number.isNaN(parseTime(set.time));
  const rangeInvalid = (set: EditSet) => set.min != null && set.max != null && Number(set.min) > Number(set.max);

  function textInput(field: Field, i: number, s: number, set: EditSet, o: { inputmode: string; label: string; placeholder?: string; invalid?: boolean }) {
    return `<input type="text" inputmode="${o.inputmode}" maxlength="7" data-field="${field}" data-i="${i}" data-s="${s}"
      class="${o.invalid ? "invalid" : ""}" value="${set[field] == null ? "" : esc(set[field])}"
      placeholder="${o.placeholder ?? "–"}" aria-label="Set ${s + 1} ${o.label}" autocomplete="off">`;
  }

  function setRow(item: EditItem, i: number, set: EditSet, s: number) {
    const cells = modesOf(item).map((m) => {
      if (m === "weight") return textInput("weight", i, s, set, { inputmode: "decimal", label: "weight in pounds" });
      if (m === "time") return textInput("time", i, s, set, { inputmode: "numeric", label: "time", placeholder: "m:ss", invalid: timeInvalid(set) });
      if (m === "distance") return textInput("distance", i, s, set, { inputmode: "decimal", label: "distance in miles" });
      const bad = rangeInvalid(set) ? " invalid" : "";
      const dis = set.amrap ? "disabled" : "";
      return `<span class="rep-range">
          <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" data-field="min" data-i="${i}" data-s="${s}" class="${bad}"
            value="${set.min ?? ""}" placeholder="${set.amrap ? "—" : "min"}" aria-label="Set ${s + 1} minimum reps" ${dis}>
          <span class="range-dash">–</span>
          <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" data-field="max" data-i="${i}" data-s="${s}" class="${bad}"
            value="${set.max ?? ""}" placeholder="${set.amrap ? "—" : "max"}" aria-label="Set ${s + 1} maximum reps" ${dis}>
        </span>
        <label class="mini-toggle">
          <input type="checkbox" data-field="amrap" data-i="${i}" data-s="${s}" ${set.amrap ? "checked" : ""}>
          <span>AMRAP</span>
        </label>`;
    });
    return `<li class="set-row" style="grid-template-columns: ${gridColumns(item)}">
      <span class="set-num">${s + 1}</span>
      ${cells.join("")}
      <button type="button" class="icon-btn" data-act="remove-set" data-i="${i}" data-s="${s}"
        aria-label="Remove set ${s + 1}" ${item.sets.length === 1 ? "disabled" : ""}>&times;</button>
    </li>`;
  }

  function card(item: EditItem, i: number) {
    const ex = byId.get(item.exercise_id)!;
    const classes = ["wx-card"];
    if (item.superset_next || (i > 0 && items[i - 1].superset_next)) classes.push("in-superset");
    if (i > 0 && items[i - 1].superset_next) classes.push("linked-above");
    if (item.superset_next) classes.push("linked-below");
    const badges = ex.modes.map((m) => `<span class="badge">${cap(m)}</span>`).join("");
    const heads = ["Set", ...ex.modes.flatMap((m) => COLUMNS[m].heads), ""];
    return `<li class="${classes.join(" ")}">
      <div class="wx-head">
        <div class="wx-title"><h3>${esc(ex.name)}</h3><div class="badges">${badges}</div></div>
        <div class="wx-actions">
          <button type="button" class="icon-btn danger" data-act="remove" data-i="${i}" aria-label="Remove ${esc(ex.name)}">&times;</button>
        </div>
      </div>
      <p class="set-hint">Targets are optional.</p>
      <div class="set-head" style="grid-template-columns: ${gridColumns(item)}" aria-hidden="true">
        ${heads.map((h) => `<span>${h}</span>`).join("")}
      </div>
      <ol class="sets">${item.sets.map((set, s) => setRow(item, i, set, s)).join("")}</ol>
      <button type="button" class="button subtle small" data-act="add-set" data-i="${i}">+ Add set</button>
    </li>`;
  }

  function link(i: number) {
    const on = items[i].superset_next;
    return `<li class="superset-link${on ? " on" : ""}">
      <label class="link-toggle">
        <input type="checkbox" data-act="superset" data-i="${i}" ${on ? "checked" : ""}>
        <span>${on ? "Supersetted" : "Superset"}</span>
      </label>
    </li>`;
  }

  // Item index ranges [start, end) of each block: a superset chain, or a lone exercise.
  function blockRanges() {
    const ranges: [number, number][] = [];
    for (let i = 0; i < items.length; i++) {
      if (i > 0 && items[i - 1].superset_next) ranges[ranges.length - 1][1] = i + 1;
      else ranges.push([i, i + 1]);
    }
    return ranges;
  }

  // Each block is one draggable <li data-block>; the superset toggles between blocks sit
  // between them as their own items.
  function render() {
    const ranges = blockRanges();
    list.innerHTML = ranges.map(([start, end], b) => {
      const inner = [];
      for (let i = start; i < end; i++) inner.push(card(items[i], i) + (i < end - 1 ? link(i) : ""));
      return `<li class="wx-block" data-block><ol class="wx-block-items">${inner.join("")}</ol></li>`
        + (b < ranges.length - 1 ? link(end - 1) : "");
    }).join("");
    empty.hidden = items.length > 0;
    hint.hidden = ranges.length < 2;
  }

  // A link after the last exercise is meaningless and would silently re-link whatever gets added next.
  const tidyLinks = () => {
    if (items.length) items[items.length - 1].superset_next = false;
  };
  const newSet = (prev?: EditSet): EditSet => (prev ? { ...prev } : { min: null, max: null, amrap: false, weight: null, time: null, distance: null });

  function addExercise(id: number) {
    items.push({
      exercise_id: id, superset_next: false,
      sets: Array.from({ length: DEFAULT_SET_COUNT }, () => newSet()),
      filled: Object.fromEntries(FIELDS.map((f) => [f, false])) as Record<Field, boolean>,
    });
    render();
  }

  // ----- Long-press to reorder (ui/dragReorder.ts), like the day view -----
  // A superset moves as one block, and every card shrinks to its name while one is lifted.
  const blockEls = () => [...list.querySelectorAll<HTMLElement>(":scope > [data-block]")];
  longPressReorder(list, {
    signal,
    items: blockEls,
    onLift: () => list.classList.add("collapsed"),
    onDrop(from, to) {
      if (to !== from) {
        const blocks = blockRanges().map(([start, end]) => items.slice(start, end));
        blocks.splice(to, 0, ...blocks.splice(from, 1));
        items.splice(0, items.length, ...blocks.flat());
        render();
      }
      // Expand the cards again, keeping the dropped block where it is on screen.
      const before = blockEls()[to].getBoundingClientRect().top;
      list.classList.remove("collapsed");
      scrollBy(0, blockEls()[to].getBoundingClientRect().top - before);
    },
  });

  list.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    switch (btn.dataset.act) {
      case "remove":
        // The exercise above stays linked only if the removed one was linked onward too.
        if (i > 0) items[i - 1].superset_next = items[i - 1].superset_next && items[i].superset_next;
        items.splice(i, 1);
        tidyLinks();
        return render();
      case "add-set": {
        const sets = items[i].sets;
        sets.push(newSet(sets[sets.length - 1]));
        render();
        const inputs = list.querySelectorAll<HTMLInputElement>(`[data-field="min"][data-i="${i}"]`);
        if (inputs.length && !inputs[inputs.length - 1].disabled) inputs[inputs.length - 1].focus();
        return;
      }
      case "remove-set":
        items[i].sets.splice(Number(btn.dataset.s), 1);
        return render();
    }
  }, { signal });

  function markValidity(i: number, s: number) {
    const set = items[i].sets[s];
    const q = (f: string) => list.querySelector(`[data-field="${f}"][data-i="${i}"][data-s="${s}"]`);
    for (const f of ["min", "max"]) q(f)?.classList.toggle("invalid", rangeInvalid(set));
    q("time")?.classList.toggle("invalid", timeInvalid(set));
  }

  const SANITIZE: Record<Field, RegExp> = { min: /\D/g, max: /\D/g, weight: /[^\d.]/g, distance: /[^\d.]/g, time: /[^\d:]/g };

  list.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    const field = el.dataset.field as Field;
    if (!FIELDS.includes(field)) return;
    el.value = el.value.replace(SANITIZE[field], "");
    const i = Number(el.dataset.i);
    const s = Number(el.dataset.s);
    const item = items[i];
    const value = el.value === "" ? null : TEXT_FIELDS.includes(field) ? el.value : Number(el.value);
    (item.sets[s] as any)[field] = value;
    markValidity(i, s);
    if (!item.filled[field]) {
      const repField = field === "min" || field === "max";
      item.sets.forEach((set, t) => {
        if (t === s || (repField && set.amrap)) return;
        (set as any)[field] = value;
        const input = list.querySelector<HTMLInputElement>(`[data-field="${field}"][data-i="${i}"][data-s="${t}"]`);
        if (input) input.value = value == null ? "" : String(value);
        markValidity(i, t);
      });
    }
  }, { signal });

  // Committing a non-empty first entry ends autofill for that column. Readable times are tidied
  // to m:ss across the exercise (autofilled copies included).
  list.addEventListener("focusout", (e) => {
    const el = e.target as HTMLInputElement;
    const field = el.dataset.field as Field;
    if (!FIELDS.includes(field)) return;
    const i = Number(el.dataset.i);
    const item = items[i];
    if (!item) return;
    if (item.sets[Number(el.dataset.s)]?.[field] != null) item.filled[field] = true;
    if (field === "time") {
      item.sets.forEach((set, t) => {
        const sec = set.time == null ? null : parseTime(set.time);
        if (sec == null || Number.isNaN(sec)) return;
        set.time = formatTime(sec);
        const input = list.querySelector<HTMLInputElement>(`[data-field="time"][data-i="${i}"][data-s="${t}"]`);
        if (input) input.value = set.time;
      });
    }
  }, { signal });

  list.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    const i = Number(el.dataset.i);
    if (el.dataset.act === "superset") {
      items[i].superset_next = el.checked;
      render();
      list.querySelector<HTMLInputElement>(`[data-act="superset"][data-i="${i}"]`)!.focus();
    } else if (el.dataset.field === "amrap") {
      const set = items[i].sets[Number(el.dataset.s)];
      set.amrap = el.checked;
      if (set.amrap) set.min = set.max = null;
      render();
      list.querySelector<HTMLInputElement>(`[data-field="amrap"][data-i="${i}"][data-s="${el.dataset.s}"]`)!.focus();
    }
  }, { signal });

  // ----- Exercise picker (bottom sheet) -----
  const pickerList = root.querySelector<HTMLElement>("#picker-list");
  const filterRoot = picker.querySelector<HTMLElement>("[data-exercise-filter]");
  const filter = filterRoot ? exerciseFilter(filterRoot, renderPicker, signal) : null;
  const none = root.querySelector<HTMLElement>("#picker-none");

  function renderPicker() {
    if (!pickerList || !filter) return;
    const counts = new Map<number, number>();
    for (const it of items) counts.set(it.exercise_id, (counts.get(it.exercise_id) || 0) + 1);
    const matches = options.filter(filter.matches);
    pickerList.innerHTML = matches.map((o) => {
      const n = counts.get(o.id);
      return `<li><button type="button" data-id="${o.id}">
        <span>${esc(o.name)}</span>
        <span class="picker-meta">${n ? `Added${n > 1 ? ` ×${n}` : ""}` : esc(o.modes.map(cap).join(" · "))}</span>
      </button></li>`;
    }).join("");
    none!.hidden = matches.length > 0;
  }

  root.querySelector("#open-picker")!.addEventListener("click", () => {
    filter?.reset();
    renderPicker();
    picker.showModal();
  }, { signal });
  root.querySelector("#close-picker")!.addEventListener("click", () => picker.close(), { signal });
  picker.addEventListener("click", (e) => {
    if (e.target === picker) picker.close(); // tap on backdrop
  }, { signal });
  // "+ New" leaves for the exercise form: keep the unsaved workout for when it comes back.
  picker.addEventListener("click", (e) => {
    if (!(e.target as Element).closest("[data-leave]")) return;
    drafts.set(draftKey, { name: root.querySelector<HTMLInputElement>("#name")!.value, items: structuredClone(items) });
  }, { signal });
  pickerList?.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("button[data-id]");
    if (!btn) return;
    addExercise(Number(btn.dataset.id));
    renderPicker();
  }, { signal });

  // ----- Save -----
  const form = root.querySelector<HTMLFormElement>("#builder-form")!;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void onSave(root.querySelector<HTMLInputElement>("#name")!.value, items);
  }, { signal });

  // Back from "+ New": restore the unsaved workout, then add the exercises made there.
  const draft = drafts.get(draftKey);
  drafts.delete(draftKey);
  if (draft) {
    root.querySelector<HTMLInputElement>("#name")!.value = draft.name;
    items.splice(0, items.length, ...draft.items.filter((it) => byId.has(it.exercise_id)));
  }
  for (const id of takeCreatedExercises(draftKey)) if (byId.has(id)) addExercise(id);
  render();
}
