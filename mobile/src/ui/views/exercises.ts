// Exercise library: list, exercise page (details + history), and the add/edit form.
// Ported from templates/exercises.html, exercise_detail.html, exercise_form.html and
// static/exercise_form.js.
import { html, nothing } from "lit-html";
import {
  deleteExercise, type Exercise, exerciseDeleteBlocker, type ExerciseForm, getExercise, listExercises, muscleChoices, saveExercise,
} from "../../logic/exercises";
import { exerciseHistory } from "../../logic/history";
import { MUSCLE_ROLES, NOTE_MAX_LENGTH, TRACKING_MODES } from "../../logic/text";
import { type Ctx, flash, navigate, refresh, route, stash, takeStash } from "../app";
import { historyList } from "./history";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function deleteButton(ex: Exercise, blocked: string | null, full: boolean) {
  return html`<button type="button"
      class=${full ? "button danger block delete-trigger" : "icon-btn danger card-delete"}
      aria-label=${full ? nothing : `Delete ${ex.name}`}
      data-confirm-delete="exercise:${ex.id}" data-name=${ex.name}
      data-detail="This permanently removes the exercise. It can’t be undone."
      data-blocked=${blocked ?? nothing}>${full ? "Delete exercise" : "×"}</button>`;
}

function registerDelete(ctx: Ctx, ex: Exercise) {
  ctx.onDelete(`exercise:${ex.id}`, async () => {
    const name = await deleteExercise(ctx.db, ex.id);
    flash(`Deleted “${name}”.`);
    navigate("#/exercises");
  });
}

route(/^\/exercises$/, async (ctx) => {
  const exercises = await listExercises(ctx.db);
  const blocked = new Map(await Promise.all(exercises.map(async (e) => [e.id, await exerciseDeleteBlocker(ctx.db, e.id)] as const)));
  for (const ex of exercises) registerDelete(ctx, ex);
  return {
    title: "Exercises",
    section: "exercises",
    content: html`
      <header class="page-header">
        <h1>Exercises</h1>
        <a class="button" href="#/exercises/new">+ Add</a>
      </header>
      ${exercises.length ? html`
        <ul class="card-list">
          ${exercises.map((ex) => html`
            <li class="card-wrap">
              <a class="card card-link" href="#/exercises/${ex.id}">
                <h2>${ex.name}</h2>
                <div class="badges">${ex.modes.map((m) => html`<span class="badge">${cap(m)}</span>`)}</div>
                <p class="muscles"><strong>Primary:</strong> ${ex.primary.join(", ")}</p>
                ${ex.ancillary.length ? html`<p class="muscles"><strong>Ancillary:</strong> ${ex.ancillary.join(", ")}</p>` : ""}
              </a>
              ${deleteButton(ex, blocked.get(ex.id) ?? null, false)}
            </li>`)}
        </ul>` : html`<p class="empty">No exercises yet. Tap <strong>+ Add</strong> to create your first one.</p>`}`,
  };
});

route(/^\/exercises\/(\d+)$/, async (ctx) => {
  const ex = await getExercise(ctx.db, Number(ctx.params[0]));
  const sessions = await exerciseHistory(ctx.db, ex);
  return {
    title: ex.name,
    tabbar: false,
    content: html`
      <header class="page-header">
        <a class="back" href="#/exercises" aria-label="Back to exercises">&larr;</a>
        <h1>${ex.name}</h1>
        <a class="button subtle" href="#/exercises/${ex.id}/edit">Edit</a>
      </header>
      <section class="card exercise-info">
        <div class="badges">${ex.modes.map((m) => html`<span class="badge">${cap(m)}</span>`)}</div>
        <p class="muscles"><strong>Primary:</strong> ${ex.primary.join(", ")}</p>
        ${ex.ancillary.length ? html`<p class="muscles"><strong>Ancillary:</strong> ${ex.ancillary.join(", ")}</p>` : ""}
        ${ex.note ? html`<p class="note exercise-note">${ex.note}</p>` : ""}
      </section>
      <h2 class="section-title">History</h2>
      ${historyList(ex, sessions, ctx.today)}`,
  };
});

route(/^\/exercises\/new$/, (ctx) => exerciseForm(ctx, null));
route(/^\/exercises\/(\d+)\/edit$/, async (ctx) => exerciseForm(ctx, await getExercise(ctx.db, Number(ctx.params[0]))));

type FormStash = { errors: string[]; form: ExerciseForm };

async function exerciseForm(ctx: Ctx, exercise: Exercise | null) {
  const stashed = takeStash<FormStash>();
  const form: ExerciseForm = stashed?.form ?? (exercise
    ? { name: exercise.name, tracking: exercise.modes, primary: exercise.primary, ancillary: exercise.ancillary, note: exercise.note ?? "" }
    : { name: "", tracking: [], primary: [], ancillary: [], note: "" });
  const errors = stashed?.errors ?? [];
  const muscles = await muscleChoices(ctx.db, [...form.primary, ...form.ancillary]);
  const selected = Object.fromEntries(MUSCLE_ROLES.map((r) => [r, new Set(form[r].map((m) => m.toLowerCase()))]));
  const blocked = exercise ? await exerciseDeleteBlocker(ctx.db, exercise.id) : null;
  if (exercise) registerDelete(ctx, exercise);

  const muscleField = (role: (typeof MUSCLE_ROLES)[number], legend: string, hint: string) => html`
    <fieldset class="field">
      <legend>${legend}</legend>
      <p class="hint">${hint}</p>
      <div class="chips" data-role=${role}>
        ${muscles.map((m) => html`
          <label class="chip">
            <input type="checkbox" name=${role} value=${m} ?checked=${selected[role].has(m.toLowerCase())}>
            <span>${m}</span>
          </label>`)}
      </div>
      <div class="add-tag">
        <input type="text" maxlength="50" placeholder="Add another muscle group" aria-label="Add a ${legend.toLowerCase()} entry" data-add-for=${role}>
        <button type="button" class="button subtle" data-add-button=${role}>Add</button>
      </div>
    </fieldset>`;

  return {
    title: exercise ? "Edit exercise" : "New exercise",
    tabbar: false,
    content: html`
      <header class="page-header">
        ${exercise
          ? html`<a class="back" href="#/exercises/${exercise.id}" aria-label="Back to ${exercise.name}">&larr;</a>`
          : html`<a class="back" href="#/exercises" aria-label="Back to exercises">&larr;</a>`}
        <h1>${exercise ? "Edit exercise" : "New exercise"}</h1>
      </header>
      ${errors.length ? html`<div class="errors" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ""}
      <form class="form" id="exercise-form" novalidate>
        <div class="field">
          <label for="name">Name</label>
          <input id="name" name="name" type="text" maxlength="100" required autocomplete="off" placeholder="e.g. Bench Press" .value=${form.name}>
        </div>
        <fieldset class="field">
          <legend>Track</legend>
          <p class="hint">What you'll log for each set.</p>
          <div class="chips grid">
            ${TRACKING_MODES.map((mode) => html`
              <label class="chip">
                <input type="checkbox" name="tracking" value=${mode} ?checked=${form.tracking.includes(mode)}>
                <span>${cap(mode)}</span>
              </label>`)}
          </div>
        </fieldset>
        ${muscleField("primary", "Primary muscle groups", "The main muscles this exercise targets.")}
        ${muscleField("ancillary", "Ancillary muscle groups", "Supporting muscles (optional).")}
        <div class="field">
          <label for="note">Note</label>
          <p class="hint">Shown every time you do this exercise, e.g. seat height or form cues (optional).</p>
          <textarea id="note" name="note" rows="3" maxlength=${NOTE_MAX_LENGTH} .value=${form.note}></textarea>
        </div>
        <button type="submit" class="button block">Save exercise</button>
      </form>
      ${exercise ? deleteButton(exercise, blocked, true) : ""}`,
    mount(root: HTMLElement, signal: AbortSignal) {
      mountMuscleChips(root, signal);
      const formEl = root.querySelector<HTMLFormElement>("#exercise-form")!;
      formEl.addEventListener("submit", async (e) => {
        e.preventDefault();
        const data = new FormData(formEl);
        const input: ExerciseForm = {
          name: String(data.get("name") ?? ""),
          tracking: data.getAll("tracking").map(String),
          primary: data.getAll("primary").map(String),
          ancillary: data.getAll("ancillary").map(String),
          note: String(data.get("note") ?? ""),
        };
        const result = await saveExercise(ctx.db, exercise?.id ?? null, input);
        if (result.ok) {
          flash(`Saved “${result.name}”.`);
          navigate(`#/exercises/${result.id}`);
        } else {
          stash({ errors: result.errors, form: result.form } satisfies FormStash);
          await refresh();
          window.scrollTo(0, 0);
        }
      }, { signal });
    },
  };
}

// A muscle group can be primary OR ancillary, not both: selecting it in one list disables it
// in the other. Custom groups typed in either list are added to both. (static/exercise_form.js)
function mountMuscleChips(root: HTMLElement, signal: AbortSignal) {
  const lists = {
    primary: root.querySelector<HTMLElement>('.chips[data-role="primary"]')!,
    ancillary: root.querySelector<HTMLElement>('.chips[data-role="ancillary"]')!,
  };
  type Role = keyof typeof lists;
  const other: Record<Role, Role> = { primary: "ancillary", ancillary: "primary" };
  const findChip = (role: Role, name: string) =>
    [...lists[role].querySelectorAll("input")].find((i) => i.value.toLowerCase() === name.toLowerCase());

  function sync() {
    for (const role of ["primary", "ancillary"] as Role[]) {
      for (const input of lists[role].querySelectorAll("input")) {
        const twin = findChip(other[role], input.value);
        input.disabled = Boolean(twin?.checked);
        input.closest<HTMLElement>(".chip")!.title = input.disabled ? `Already selected as ${other[role]}` : "";
      }
    }
  }

  function makeChip(role: Role, name: string) {
    const label = document.createElement("label");
    label.className = "chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = role;
    input.value = name;
    const span = document.createElement("span");
    span.textContent = name;
    label.append(input, span);
    lists[role].append(label);
  }

  const normalize = (raw: string) => {
    const name = raw.replace(/^#+/, "").trim().replace(/\s+/g, " ").slice(0, 50);
    return name === name.toLowerCase() ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : name;
  };

  function addCustom(role: Role) {
    const field = root.querySelector<HTMLInputElement>(`[data-add-for="${role}"]`)!;
    const name = normalize(field.value);
    if (!name) return;
    for (const r of ["primary", "ancillary"] as Role[]) if (!findChip(r, name)) makeChip(r, name);
    const input = findChip(role, name)!;
    if (!input.disabled) input.checked = true;
    field.value = "";
    sync();
    field.focus();
  }

  root.addEventListener("change", (e) => {
    if ((e.target as Element).matches(".chips[data-role] input")) sync();
  }, { signal });
  for (const role of ["primary", "ancillary"] as Role[]) {
    root.querySelector(`[data-add-button="${role}"]`)!.addEventListener("click", () => addCustom(role), { signal });
    root.querySelector(`[data-add-for="${role}"]`)!.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        e.preventDefault(); // don't submit the form
        addCustom(role);
      }
    }, { signal });
  }
  sync();
}
