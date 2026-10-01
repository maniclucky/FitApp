// Search + muscle filter for exercise pickers (templates/_exercise_filter.html and
// static/exercise_filter.js). Role toggles (user requirement): both start off and are
// disabled until a muscle is picked. Picking a muscle while both are off turns Primary on.
// With a muscle picked, an exercise matches if it has that muscle in a checked role; with
// both roles off, the muscle doesn't filter at all. "All muscles" turns both off again.
import { html } from "lit-html";
import type { PickerOption } from "../logic/exercises";

export function filterControls(muscles: string[]) {
  return html`
    <div class="ex-filter" data-exercise-filter>
      <input type="text" data-filter-search placeholder="Search exercises" aria-label="Search exercises" autocomplete="off">
      <div class="ex-filter-row">
        <select data-filter-muscle aria-label="Filter by muscle">
          <option value="">All muscles</option>
          ${muscles.map((m) => html`<option>${m}</option>`)}
        </select>
        <div class="role-toggles" role="group" aria-label="Match the muscle as">
          <label class="mini-toggle"><input type="checkbox" data-filter-role="primary" disabled><span>Primary</span></label>
          <label class="mini-toggle"><input type="checkbox" data-filter-role="ancillary" disabled><span>Ancillary</span></label>
        </div>
      </div>
    </div>`;
}

export interface FilterState {
  search: string;
  muscle: string;
  roles: string[];
}

export interface ExerciseFilter {
  matches(option: Pick<PickerOption, "name" | "primary" | "ancillary">): boolean;
  reset(): void;
  /** The current settings, to put back with restore() after the screen re-renders. */
  state(): FilterState;
  restore(state: FilterState): void;
}

export function exerciseFilter(root: HTMLElement, onChange: () => void, signal: AbortSignal): ExerciseFilter {
  const search = root.querySelector<HTMLInputElement>("[data-filter-search]")!;
  const muscle = root.querySelector<HTMLSelectElement>("[data-filter-muscle]")!;
  const roles = [...root.querySelectorAll<HTMLInputElement>("[data-filter-role]")];
  const primary = roles.find((r) => r.dataset.filterRole === "primary")!;

  search.addEventListener("input", onChange, { signal });
  muscle.addEventListener("change", () => {
    for (const r of roles) {
      r.disabled = !muscle.value;
      if (!muscle.value) r.checked = false;
    }
    if (muscle.value && !roles.some((r) => r.checked)) primary.checked = true;
    onChange();
  }, { signal });
  for (const r of roles) r.addEventListener("change", onChange, { signal });

  return {
    matches(option) {
      if (!option.name.toLowerCase().includes(search.value.trim().toLowerCase())) return false;
      const checked = roles.filter((r) => r.checked);
      if (!muscle.value || !checked.length) return true;
      const want = muscle.value.toLowerCase();
      return checked.some((r) => option[r.dataset.filterRole as "primary" | "ancillary"].some((m) => m.toLowerCase() === want));
    },
    reset() {
      search.value = "";
      muscle.value = "";
      for (const r of roles) {
        r.checked = false;
        r.disabled = true;
      }
    },
    state: () => ({ search: search.value, muscle: muscle.value, roles: roles.filter((r) => r.checked).map((r) => r.dataset.filterRole!) }),
    restore(state) {
      search.value = state.search;
      // A muscle that no exercise uses any more isn't an option; fall back to "All muscles".
      muscle.value = [...muscle.options].some((o) => o.value === state.muscle) ? state.muscle : "";
      for (const r of roles) {
        r.disabled = !muscle.value;
        r.checked = Boolean(muscle.value) && state.roles.includes(r.dataset.filterRole!);
      }
    },
  };
}
