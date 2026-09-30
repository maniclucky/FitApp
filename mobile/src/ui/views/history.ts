// An exercise's past sessions (templates/_exercise_history.html). Used by the exercise page
// and the day view's History sheet.
import { html } from "lit-html";
import type { Exercise } from "../../logic/exercises";
import { HISTORY_LIMIT, type Session, setResult } from "../../logic/history";
import { historyDate } from "../../logic/text";

export function historyList(exercise: Exercise, sessions: Session[], today: string) {
  if (!sessions.length) {
    return html`<p class="empty small">No history yet. Sets and session notes you log for this exercise will show up here.</p>`;
  }
  return html`
    <ol class="history">
      ${sessions.map((s) => html`
        <li class="history-day">
          <div class="history-head">
            <a href="#/day/${s.date}">${historyDate(s.date, today)}</a>
            ${s.workouts.length ? html`<span class="picker-meta">${s.workouts.join(", ")}</span>` : ""}
          </div>
          ${s.notes.map((note) => html`<p class="note session-note">${note}</p>`)}
          ${s.sets.length ? html`
            <ol class="history-sets">
              ${s.sets.map((set, i) => html`
                <li class=${set.completed_at ? "" : "not-done"}>
                  <span class="set-num">${i + 1}</span>
                  <span>${setResult(set, exercise)}</span>
                  ${set.completed_at ? "" : html`<span class="picker-meta">not checked off</span>`}
                </li>`)}
            </ol>` : ""}
        </li>`)}
    </ol>
    ${sessions.length === HISTORY_LIMIT ? html`<p class="hint history-more">Showing the ${HISTORY_LIMIT} most recent days.</p>` : ""}`;
}
