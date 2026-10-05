// Routines: list, the routine editor (Workouts + Volume Planning tabs) and the target preset
// page. Ported from templates/routines.html, routine_form.html, preset_form.html and
// static/routine_form.js.
import { html, nothing } from "lit-html";
import { orderedMuscleGroups } from "../../logic/muscles";
import { deletePreset, getPreset, listPresets, type Preset, presetTexts, savePreset } from "../../logic/presets";
import {
  deleteRoutine, getRoutine, listRoutines, type Routine, type RoutineForm, saveRoutine, targetTexts,
} from "../../logic/routines";
import { formatNumber, MUSCLE_SET_WEIGHTS, truncate1 } from "../../logic/text";
import { listWorkouts, workoutMuscleSets } from "../../logic/workouts";
import { type Ctx, currentPath, flash, href, navigate, refresh, route, stash, takeStash } from "../app";
import { cardCopyButton, copyHref, copyName } from "../copy";
import { longPressReorder } from "../dragReorder";

const ROUTINE_DELETE_DETAIL = "This removes the routine only. Its workouts and your logged days stay.";

function registerRoutineDelete(ctx: Ctx, r: { id: number }) {
  ctx.onDelete(`routine:${r.id}`, async () => {
    const name = await deleteRoutine(ctx.db, r.id);
    flash(`Deleted “${name}”.`);
    navigate("#/routines");
  });
}

route(/^\/routines$/, async (ctx) => {
  const routines = await listRoutines(ctx.db);
  const names = new Map((await listWorkouts(ctx.db)).map((w) => [w.id, w.name]));
  for (const r of routines) registerRoutineDelete(ctx, r);
  return {
    title: "Routines",
    section: "routines",
    content: html`
      <header class="page-header">
        <h1>Routines</h1>
        <a class="button" href="#/routines/new">+ New</a>
      </header>
      ${routines.length ? html`
        <ul class="card-list">
          ${routines.map((r) => html`
            <li class="card-wrap">
              <div class="card card-stretch">
                <h2><a class="card-cover" href="#/routines/${r.id}">${r.name}</a></h2>
                <ol class="routine-summary">
                  ${r.workout_ids.map((wid, i) => html`
                    <li><a href=${href(`/workouts/${wid}`, { next: "#/routines" })}>
                      <span class="routine-num">${i + 1}</span><span>${names.get(wid)}</span><span class="chevron" aria-hidden="true">&rsaquo;</span>
                    </a></li>`)}
                </ol>
              </div>
              ${cardCopyButton("routines", r.id, r.name)}
              <button type="button" class="icon-btn danger card-delete" aria-label="Delete ${r.name}"
                      data-confirm-delete="routine:${r.id}" data-name=${r.name} data-detail=${ROUTINE_DELETE_DETAIL}>&times;</button>
            </li>`)}
        </ul>` : html`<p class="empty">No routines yet. A routine is a saved set of workouts,<br>like Push / Pull / Legs. Tap <strong>+ New</strong> to make one.</p>`}`,
  };
});

route(/^\/routines\/new$/, (ctx) => routineForm(ctx, null));
route(/^\/routines\/(\d+)$/, async (ctx) => routineForm(ctx, await getRoutine(ctx.db, Number(ctx.params[0]))));

type RoutineStash = { errors: string[]; badTargets: Set<number>; form: { name: string; workout_ids: number[]; cycle_days: string; autoregulate: boolean; targets: Record<number, string> } };
// Unsaved routine edits kept while visiting the preset page (restored on return), by path.
type Draft = { name: string; ids: number[]; cycle: string; autoregulate: boolean; targets: Record<string, string> };
const drafts = new Map<string, Draft>();

async function routineForm(ctx: Ctx, routine: Routine | null) {
  const stashed = takeStash<RoutineStash>();
  const copyId = Number(ctx.query.get("copy"));
  const source = routine ?? (copyId ? await getRoutine(ctx.db, copyId) : null);
  const name = stashed?.form.name ?? (routine ? routine.name : source ? copyName(source.name) : "");
  const workoutIds = stashed?.form.workout_ids ?? source?.workout_ids ?? [];
  const cycleDays = stashed?.form.cycle_days ?? (source ? String(source.cycle_days) : "7");
  const autoregulate = stashed?.form.autoregulate ?? source?.autoregulate ?? false;
  const targets = stashed?.form.targets ?? targetTexts(source);
  const errors = stashed?.errors ?? [];
  const badTargets = stashed?.badTargets ?? new Set<number>();
  const muscles = await orderedMuscleGroups(ctx.db);
  const workouts = await listWorkouts(ctx.db);
  const options = workouts.map((w) => ({ id: w.id, name: w.name, count: w.slots.length, muscles: workoutMuscleSets(w) }));
  const presets = await listPresets(ctx.db);
  const here = `#${currentPath()}`;
  const cycleInvalid = errors.length > 0 && !(/^\d+$/.test(cycleDays) && Number(cycleDays) >= 1 && Number(cycleDays) <= 365);
  if (routine) registerRoutineDelete(ctx, routine);

  const presetSummary = (p: Preset) => {
    const values = [...p.sets.values()];
    return `${values.filter(Boolean).length} groups · ${formatNumber(values.reduce((a, b) => a + b, 0))} sets/week`;
  };

  return {
    title: routine ? "Edit routine" : "New routine",
    tabbar: false,
    content: html`
      <header class="page-header">
        <a class="back" href="#/routines" aria-label="Back to routines">&larr;</a>
        <h1>${routine ? "Edit routine" : "New routine"}</h1>
        ${routine ? html`<a class="button subtle" href=${copyHref("routines", routine.id)}>Copy</a>` : ""}
      </header>
      ${errors.length ? html`<div class="errors" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ""}
      <form class="form" id="routine-form" novalidate>
        <div class="field">
          <label for="name">Name</label>
          <input id="name" name="name" type="text" maxlength="100" required autocomplete="off" autocapitalize="words" placeholder="e.g. Push / Pull / Legs" .value=${name}>
        </div>
        <div class="segmented two" role="tablist" aria-label="Routine sections">
          <button type="button" role="tab" id="tab-workouts" aria-controls="panel-workouts" aria-selected="true" data-tab="workouts">Workouts</button>
          <button type="button" role="tab" id="tab-volume" aria-controls="panel-volume" aria-selected="false" tabindex="-1" data-tab="volume">Volume Planning</button>
        </div>
        <div class="field" role="tabpanel" id="panel-workouts" aria-labelledby="tab-workouts">
          <p class="hint">In the order you do them. A workout can appear more than once. Long-press a workout to drag it into a new order.</p>
          <ol class="builder-list" id="routine-list"></ol>
          <p class="empty small" id="routine-empty">No workouts yet.</p>
          <button type="button" class="button subtle block" id="open-picker">+ Add workout</button>
          <label class="switch">
            <input type="checkbox" id="autoregulate" name="autoregulate" .checked=${autoregulate}>
            <span>Autoregulation</span>
          </label>
          <p class="hint">Sets each workout’s rep and weight targets from the last time you did it: one more rep
            if you hit the target, +5&nbsp;lb past the top of the rep range, −5&nbsp;lb below the bottom
            (8–15 when a set has no range). Deload days are skipped.</p>
        </div>
        <div class="field" role="tabpanel" id="panel-volume" aria-labelledby="tab-volume" hidden>
          <div class="cycle-days">
            <label for="cycle_days">Days to complete the routine</label>
            <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off"
                   id="cycle_days" name="cycle_days" .value=${cycleDays} class=${cycleInvalid ? "invalid" : ""}>
          </div>
          <div class="preset-row">
            <button type="button" class="button subtle" id="open-presets">Presets</button>
            <p class="hint" id="preset-status" aria-live="polite"></p>
          </div>
          <p class="hint">Weekly sets per muscle group: one pass through the routine, scaled by
            7&nbsp;÷&nbsp;<span data-cycle-echo>${cycleDays}</span> days. A primary muscle counts
            ${MUSCLE_SET_WEIGHTS.primary} per set; an ancillary muscle counts ${MUSCLE_SET_WEIGHTS.ancillary}.
            Enter the weekly minimum for each group (or apply a preset); the bar fills toward it.</p>
          <ul class="muscle-volume" id="muscle-volume">
            ${muscles.map((mg) => html`
              <li data-muscle=${mg.name}>
                <div class="mv-head">
                  <label class="mv-name" for="target-${mg.id}">${mg.name}</label>
                  <span class="mv-total"><span data-total>0</span> <span class="mv-unit">of</span>
                    <input type="text" inputmode="decimal" autocomplete="off" maxlength="6"
                           class="mv-target${badTargets.has(mg.id) ? " invalid" : ""}"
                           id="target-${mg.id}" name="target-${mg.id}" .value=${targets[mg.id] ?? ""}
                           placeholder="–" aria-label="Target sets for ${mg.name}">
                    <span class="mv-unit">sets</span></span>
                </div>
                <div class="mv-bar" aria-hidden="true"><span></span></div>
                <div class="mv-detail" data-detail></div>
              </li>`)}
          </ul>
        </div>
        <button type="submit" class="button block">Save routine</button>
      </form>
      ${routine ? html`
        <button type="button" class="button danger block delete-trigger" data-confirm-delete="routine:${routine.id}"
                data-name=${routine.name} data-detail=${ROUTINE_DELETE_DETAIL}>Delete routine</button>` : ""}
      <dialog class="sheet" id="preset-sheet" aria-labelledby="preset-sheet-title">
        <div class="sheet-head">
          <h2 id="preset-sheet-title">Target presets</h2>
          <button type="button" class="button subtle" data-close>Cancel</button>
        </div>
        <p class="hint">Fills every group’s weekly minimum. Groups a preset leaves out get 0.</p>
        ${presets.length ? html`
          <ul class="picker-list">
            ${presets.map((p) => html`
              <li class="pick-item">
                <div class="pick-row">
                  <button type="button" class="pick-toggle" data-preset=${p.id}>
                    <span>${p.name}<span class="picker-sub">${presetSummary(p)}</span></span>
                  </button>
                  <a class="button subtle small" data-leave href=${href(`/presets/${p.id}`, { next: here })}>Edit</a>
                </div>
              </li>`)}
          </ul>` : html`<p class="empty small">No presets yet.</p>`}
        <a class="button block" data-leave href=${href("/presets/new", { next: here })}>+ New preset</a>
      </dialog>
      <dialog class="sheet" id="picker" aria-labelledby="picker-title">
        <div class="sheet-head">
          <h2 id="picker-title">Add workouts</h2>
          <button type="button" class="button" id="close-picker">Done</button>
        </div>
        ${options.length ? html`<ul class="picker-list" id="picker-list"></ul>`
          : html`<p class="empty small">You haven't built any workouts yet. <a href="#/workouts/new">Build one first</a>.</p>`}
      </dialog>`,
    mount(root: HTMLElement, signal: AbortSignal) {
      mountRoutineEditor(root, signal, { options, presets, initialIds: workoutIds, draftKey: here }, async (form) => {
        const result = await saveRoutine(ctx.db, routine?.id ?? null, form);
        if (result.ok) {
          flash(`Saved “${result.name}”.`);
          navigate("#/routines");
        } else {
          stash({ errors: result.errors, badTargets: result.badTargets, form: result.form } satisfies RoutineStash);
          await refresh();
          window.scrollTo(0, 0);
        }
      });
    },
  };
}

type WorkoutOption = { id: number; name: string; count: number; muscles: Record<string, { primary: number; ancillary: number }> };

// static/routine_form.js: the routine is an ordered array of workout ids (repeats allowed). The
// Volume Planning tab totals sets per muscle group live from it (primary 1 / ancillary 0.5 per set),
// scales them to a week by 7 / cycle_days, and compares them with the weekly minimum inputs.
function mountRoutineEditor(
  root: HTMLElement, signal: AbortSignal,
  opts: { options: WorkoutOption[]; presets: Preset[]; initialIds: number[]; draftKey: string },
  onSave: (form: RoutineForm) => Promise<void>,
) {
  const { options, presets } = opts;
  const byId = new Map(options.map((o) => [o.id, o]));
  const ids = opts.initialIds.filter((id) => byId.has(id));
  const list = root.querySelector<HTMLElement>("#routine-list")!;
  const empty = root.querySelector<HTMLElement>("#routine-empty")!;
  const picker = root.querySelector<HTMLDialogElement>("#picker")!;
  const pickerList = root.querySelector<HTMLElement>("#picker-list");
  const volumeList = root.querySelector<HTMLElement>("#muscle-volume")!;
  const cycleInput = root.querySelector<HTMLInputElement>("#cycle_days")!;
  const nameInput = root.querySelector<HTMLInputElement>("#name")!;
  const autoregulateInput = root.querySelector<HTMLInputElement>("#autoregulate")!;
  const esc = (s: unknown) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const targetInputs = () => [...volumeList.querySelectorAll<HTMLInputElement>(".mv-target")];

  function render() {
    list.innerHTML = ids.map((id, i) => {
      const w = byId.get(id)!;
      return `<li class="wx-card routine-item">
        <span class="routine-num">${i + 1}</span>
        <div class="wx-title"><h3>${esc(w.name)}</h3><span class="picker-meta">${plural(w.count, "exercise")}</span></div>
        <div class="wx-actions">
          <button type="button" class="icon-btn danger" data-act="remove" data-i="${i}" aria-label="Remove ${esc(w.name)}">&times;</button>
        </div>
      </li>`;
    }).join("");
    empty.hidden = ids.length > 0;
    renderVolume();
  }

  // Days for one pass through the routine; values scale by 7 / days to weekly. Invalid -> 7.
  const cycleDays = () => {
    const n = Number(cycleInput.value);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 7;
  };
  const readTarget = (input: HTMLInputElement) => {
    const raw = input.value.trim();
    const n = Number(raw);
    return raw === "" || !Number.isFinite(n) || n < 0 ? null : n;
  };

  function renderVolume() {
    const raw = new Map<string, { primary: number; ancillary: number }>();
    for (const id of ids) {
      for (const [muscle, counts] of Object.entries(byId.get(id)!.muscles)) {
        const c = raw.get(muscle) ?? { primary: 0, ancillary: 0 };
        c.primary += counts.primary;
        c.ancillary += counts.ancillary;
        raw.set(muscle, c);
      }
    }
    const scale = 7 / cycleDays();
    root.querySelector("[data-cycle-echo]")!.textContent = String(cycleDays());
    for (const row of volumeList.children as HTMLCollectionOf<HTMLElement>) {
      const c = raw.get(row.dataset.muscle!) ?? { primary: 0, ancillary: 0 };
      const primary = c.primary * scale;
      const ancillary = c.ancillary * scale;
      const total = primary * MUSCLE_SET_WEIGHTS.primary + ancillary * MUSCLE_SET_WEIGHTS.ancillary;
      const target = readTarget(row.querySelector(".mv-target")!);
      row.querySelector("[data-total]")!.textContent = truncate1(total);
      const parts: string[] = [];
      if (primary) parts.push(`${truncate1(primary)} primary`);
      if (ancillary) parts.push(`${truncate1(ancillary)} ancillary`);
      // Targets are weekly minimums; 0 (or blank) means no minimum, so no bar.
      const hasMin = target != null && target > 0;
      if (hasMin && total > target) parts.push(`+${truncate1(total - target)} above`);
      row.querySelector("[data-detail]")!.textContent = parts.join(" · ");
      row.querySelector<HTMLElement>(".mv-bar span")!.style.width = `${hasMin ? Math.min(1, total / target) * 100 : 0}%`;
      row.classList.toggle("no-target", !hasMin);
      row.classList.toggle("met", hasMin && total >= target);
      row.classList.toggle("none", total === 0 && !hasMin);
    }
  }

  cycleInput.addEventListener("input", () => {
    cycleInput.value = cycleInput.value.replace(/\D/g, "");
    cycleInput.classList.remove("invalid");
    renderVolume();
  }, { signal });
  volumeList.addEventListener("input", (e) => {
    const el = e.target as HTMLElement;
    if (el.classList.contains("mv-target")) {
      el.classList.remove("invalid");
      renderVolume();
    }
  }, { signal });

  // ----- Presets: fill every target input (missing muscle = 0); saved only with the routine -----
  const presetSheet = root.querySelector<HTMLDialogElement>("#preset-sheet")!;
  const presetStatus = root.querySelector<HTMLElement>("#preset-status")!;
  root.querySelector("#open-presets")!.addEventListener("click", () => presetSheet.showModal(), { signal });
  presetSheet.addEventListener("click", (e) => {
    const t = e.target as Element;
    if (t === presetSheet || t.closest("[data-close]")) return presetSheet.close();
    if (t.closest("[data-leave]")) {
      // Keep unsaved edits while visiting the preset page; restored when we come back.
      drafts.set(opts.draftKey, {
        name: nameInput.value, ids: [...ids], cycle: cycleInput.value, autoregulate: autoregulateInput.checked,
        targets: Object.fromEntries(targetInputs().map((i) => [i.name, i.value])),
      });
      return;
    }
    const btn = t.closest<HTMLElement>("[data-preset]");
    if (!btn) return;
    const preset = presets.find((p) => p.id === Number(btn.dataset.preset))!;
    for (const input of targetInputs()) {
      input.value = String(preset.sets.get(Number(input.name.replace("target-", ""))) ?? 0);
      input.classList.remove("invalid");
    }
    presetStatus.textContent = `Applied “${preset.name}”. Save the routine to keep it.`;
    presetSheet.close();
    renderVolume();
  }, { signal });

  function restoreDraft() {
    const draft = drafts.get(opts.draftKey);
    drafts.delete(opts.draftKey);
    if (!draft) return false;
    nameInput.value = draft.name;
    ids.splice(0, ids.length, ...draft.ids.filter((id) => byId.has(id)));
    cycleInput.value = draft.cycle;
    autoregulateInput.checked = draft.autoregulate;
    for (const input of targetInputs()) if (input.name in draft.targets) input.value = draft.targets[input.name];
    return true;
  }

  // ----- Tabs -----
  const tabs = [...root.querySelectorAll<HTMLElement>("[data-tab]")];
  function showTab(key: string) {
    for (const tab of tabs) {
      const on = tab.dataset.tab === key;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      root.querySelector<HTMLElement>(`#panel-${tab.dataset.tab}`)!.hidden = !on;
    }
  }
  for (const tab of tabs) tab.addEventListener("click", () => showTab(tab.dataset.tab!), { signal });
  tabs[0].parentElement!.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next.dataset.tab!);
    next.focus();
  }, { signal });

  list.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("button[data-act]");
    if (!btn) return;
    if (btn.dataset.act !== "remove") return;
    ids.splice(Number(btn.dataset.i), 1);
    render();
  }, { signal });

  // Long-press a workout and drag it into place (user requirement; replaced the ↑/↓ buttons).
  longPressReorder(list, {
    signal,
    items: () => [...list.querySelectorAll<HTMLElement>(":scope > li")],
    onDrop(from, to) {
      if (from === to) return;
      ids.splice(to, 0, ...ids.splice(from, 1));
      render();
    },
  });

  // ----- Workout picker -----
  function renderPicker() {
    if (!pickerList) return;
    pickerList.innerHTML = options.map((o) => {
      const n = ids.filter((id) => id === o.id).length;
      return `<li><button type="button" data-id="${o.id}">
        <span>${esc(o.name)}</span>
        <span class="picker-meta">${n ? `Added${n > 1 ? ` ×${n}` : ""}` : plural(o.count, "exercise")}</span>
      </button></li>`;
    }).join("");
  }
  root.querySelector("#open-picker")!.addEventListener("click", () => {
    renderPicker();
    picker.showModal();
  }, { signal });
  root.querySelector("#close-picker")!.addEventListener("click", () => picker.close(), { signal });
  picker.addEventListener("click", (e) => {
    if (e.target === picker) picker.close();
  }, { signal });
  pickerList?.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("button[data-id]");
    if (!btn) return;
    ids.push(Number(btn.dataset.id));
    render();
    renderPicker();
  }, { signal });

  root.querySelector<HTMLFormElement>("#routine-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    void onSave({
      name: nameInput.value,
      workout_ids: [...ids],
      cycle_days: cycleInput.value,
      autoregulate: autoregulateInput.checked,
      targets: Object.fromEntries(targetInputs().map((i) => [Number(i.name.replace("target-", "")), i.value])),
    });
  }, { signal });

  const restored = restoreDraft();
  render();
  if (restored) showTab("volume");
}

// ---------- Target presets ----------

route(/^\/presets\/new$/, (ctx) => presetForm(ctx, null));
route(/^\/presets\/(\d+)$/, async (ctx) => presetForm(ctx, await getPreset(ctx.db, Number(ctx.params[0]))));

type PresetStash = { errors: string[]; bad: Set<number>; name: string; values: Record<number, string> };

async function presetForm(ctx: Ctx, preset: Preset | null) {
  const next = ctx.query.get("next");
  const back = next && next.startsWith("#/") ? next : "#/routines";
  const stashed = takeStash<PresetStash>();
  const name = stashed?.name ?? preset?.name ?? "";
  const values = stashed?.values ?? presetTexts(preset);
  const bad = stashed?.bad ?? new Set<number>();
  const errors = stashed?.errors ?? [];
  const muscles = await orderedMuscleGroups(ctx.db);
  if (preset) {
    ctx.onDelete(`preset:${preset.id}`, async () => {
      const deleted = await deletePreset(ctx.db, preset.id);
      flash(`Deleted preset “${deleted}”.`);
      navigate(back);
    });
  }
  return {
    title: preset ? "Edit preset" : "New preset",
    tabbar: false,
    content: html`
      <header class="page-header">
        <a class="back" href=${back} aria-label="Back">&larr;</a>
        <h1>${preset ? "Edit preset" : "New preset"}</h1>
      </header>
      ${errors.length ? html`<div class="errors" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ""}
      <form class="form" id="preset-form" novalidate>
        <div class="field">
          <label for="name">Name</label>
          <input id="name" name="name" type="text" maxlength="100" required autocomplete="off" placeholder="e.g. Hypertrophy" .value=${name}>
        </div>
        <fieldset class="field">
          <legend>Weekly minimum sets</legend>
          <p class="hint">Leave a group blank for 0.</p>
          <ul class="preset-values">
            ${muscles.map((mg) => html`
              <li>
                <label for="sets-${mg.id}">${mg.name}</label>
                <input type="text" inputmode="decimal" autocomplete="off" maxlength="6" class=${bad.has(mg.id) ? "invalid" : ""}
                       id="sets-${mg.id}" name="sets-${mg.id}" .value=${values[mg.id] ?? ""} placeholder="0">
              </li>`)}
          </ul>
        </fieldset>
        <button type="submit" class="button block">Save preset</button>
      </form>
      ${preset ? html`
        <button type="button" class="button danger block delete-trigger" data-confirm-delete="preset:${preset.id}"
                data-name=${preset.name} data-detail="Removes the preset. Routines that used it keep their targets.">Delete preset</button>` : nothing}`,
    mount(root: HTMLElement, signal: AbortSignal) {
      const form = root.querySelector<HTMLFormElement>("#preset-form")!;
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const data = new FormData(form);
        const input = Object.fromEntries(muscles.map((mg) => [mg.id, String(data.get(`sets-${mg.id}`) ?? "")]));
        const result = await savePreset(ctx.db, preset?.id ?? null, String(data.get("name") ?? ""), input);
        if (result.ok) {
          flash(`Saved preset “${result.name}”.`);
          navigate(back);
        } else {
          stash({ errors: result.errors, bad: result.bad, name: result.name, values: result.values } satisfies PresetStash);
          await refresh();
          window.scrollTo(0, 0);
        }
      }, { signal });
    },
  };
}
