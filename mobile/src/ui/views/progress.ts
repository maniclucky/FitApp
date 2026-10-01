// Progress: daily volume chart and sets per muscle group over a date range. Ported from
// templates/progress.html.
import { html } from "lit-html";
import { listPresets, type Preset, savePreset } from "../../logic/presets";
import {
  progressData, progressRange, progressTargets, rangePresets, replaceProgressTargets, saveProgressTarget,
} from "../../logic/progress";
import { formatNumber, formatVolume, historyDate, truncate1 } from "../../logic/text";
import { currentPath, flash, href, navigate, refresh, route } from "../app";
import { mountVolumeChart } from "../volumeChart";

route(/^\/progress$/, async (ctx) => {
  const { today } = ctx;
  let range = progressRange(ctx.query.get("start"), ctx.query.get("end"), today);
  if (range.error) {
    flash(range.error, true);
    range = progressRange(null, null, today);
  }
  const { start, end } = range;
  const p = await progressData(ctx.db, start, end);
  const targets = await progressTargets(ctx.db);
  const presets = await listPresets(ctx.db);
  const here = `#${currentPath()}`;
  const label = (iso: string) => historyDate(iso, today);
  return {
    title: "Progress",
    section: "progress",
    content: html`
      <header class="page-header"><h1>Progress</h1></header>
      <section class="range-filter" aria-label="Date range">
        <div class="range-presets">
          ${rangePresets(today).map(([name, presetStart]) => html`
            <a class="chip-link" href=${href("/progress", { start: presetStart, end: today })}
               aria-current=${start === presetStart && end === today ? "true" : "false"}>${name}</a>`)}
        </div>
        <form class="range-custom" id="range-form">
          <label>From <input type="date" name="start" .value=${start} max=${today}></label>
          <label>To <input type="date" name="end" .value=${end}></label>
          <button type="submit" class="button subtle small">Apply</button>
        </form>
        <p class="hint range-note">${label(start)} – ${label(end)} · ${p.nDays} day${p.nDays === 1 ? "" : "s"}. Only completed (✓) sets count.</p>
      </section>
      <section class="kpis" aria-label="Totals">
        <div class="kpi"><span class="kpi-value">${formatVolume(p.totalVolume)}</span><span class="kpi-label">lb volume</span></div>
        <div class="kpi"><span class="kpi-value">${p.trainingDays}</span><span class="kpi-label">lifting days</span></div>
        <div class="kpi"><span class="kpi-value">${p.completedSets}</span><span class="kpi-label">sets done</span></div>
      </section>
      <section class="card chart-card">
        <h2>Volume per day</h2>
        <p class="hint">Sum of weight × reps across completed sets, in lb.</p>
        ${p.totalVolume ? html`
          <div class="chart" id="volume-chart" tabindex="0" role="img"
               aria-label="Bar chart of volume per day from ${label(start)} to ${label(end)}. Use the left and right arrow keys to read each day, or open the table below.">
            <div class="chart-tooltip" id="chart-tooltip" hidden><strong></strong><span></span></div>
          </div>
          <details class="table-view">
            <summary>Show as table</summary>
            <table>
              <thead><tr><th scope="col">Day</th><th scope="col">Volume (lb)</th></tr></thead>
              <tbody>
                ${p.days.filter((d) => d.volume).map((d) => html`
                  <tr><td><a href="#/day/${d.date}">${label(d.date)}</a></td><td>${formatVolume(d.volume)}</td></tr>`)}
              </tbody>
            </table>
          </details>` : html`<p class="empty small">No completed weight × reps sets in this range.</p>`}
      </section>
      <section class="card">
        <div class="section-head">
          <h2>Sets per muscle group</h2>
          <button type="button" class="button subtle small" id="open-presets">Presets</button>
        </div>
        <p class="hint">Completed sets in this range: primary muscle 1 per set, ancillary 0.5. Per week = total × 7 ÷ ${p.nDays} days.
          Enter a weekly minimum for each group (or load a preset); the bar fills toward it.</p>
        <ul class="muscle-volume" id="progress-targets">
          ${p.muscles.map((m) => html`
            <li data-id=${m.id} data-name=${m.name} data-week=${m.per_week} data-total-range=${m.total}>
              <div class="mv-head">
                <label class="mv-name" for="target-${m.id}">${m.name}</label>
                <span class="mv-total"><span data-total>${truncate1(m.per_week)}</span> <span class="mv-unit">of</span>
                  <input type="text" inputmode="decimal" autocomplete="off" maxlength="6" class="mv-target"
                         id="target-${m.id}" .value=${targets.has(m.id) ? formatNumber(targets.get(m.id)!) : ""}
                         placeholder="–" aria-label="Weekly minimum sets for ${m.name}">
                  <span class="mv-unit">/wk</span></span>
              </div>
              <div class="mv-bar" aria-hidden="true"><span></span></div>
              <div class="mv-detail" data-detail></div>
            </li>`)}
        </ul>
      </section>
      <dialog class="sheet" id="preset-sheet" aria-labelledby="preset-sheet-title">
        <div class="sheet-head">
          <h2 id="preset-sheet-title">Target presets</h2>
          <button type="button" class="button subtle" data-close>Cancel</button>
        </div>
        <p class="hint">Loading a preset replaces every group’s weekly minimum. Groups it leaves out get 0.</p>
        ${presets.length ? html`
          <ul class="picker-list">
            ${presets.map((pr) => html`
              <li class="pick-item">
                <div class="pick-row">
                  <button type="button" class="pick-toggle" data-preset=${pr.id}>
                    <span>${pr.name}<span class="picker-sub">${presetSummary(pr)}</span></span>
                  </button>
                  <a class="button subtle small" href=${href(`/presets/${pr.id}`, { next: here })}>Edit</a>
                </div>
              </li>`)}
          </ul>` : html`<p class="empty small">No presets yet.</p>`}
        <form class="save-preset" id="save-preset" novalidate>
          <label for="preset-name">Save these targets as a preset</label>
          <div class="add-tag">
            <input id="preset-name" type="text" maxlength="100" autocomplete="off" autocapitalize="words" placeholder="Preset name">
            <button type="submit" class="button">Save</button>
          </div>
        </form>
      </dialog>`,
    mount(root: HTMLElement, signal: AbortSignal) {
      const chart = root.querySelector<HTMLElement>("#volume-chart");
      if (chart) mountVolumeChart(chart, p.days, signal);
      mountTargets(root, signal, ctx.db, presets);
      const form = root.querySelector<HTMLFormElement>("#range-form")!;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const data = new FormData(form);
        navigate(href("/progress", { start: String(data.get("start") ?? ""), end: String(data.get("end") ?? "") }));
      }, { signal });
    },
  };
});

const presetSummary = (pr: Preset) => {
  const values = [...pr.sets.values()];
  return `${values.filter(Boolean).length} groups · ${formatNumber(values.reduce((a, b) => a + b, 0))} sets/week`;
};

// Weekly minimum per muscle group: bars update as you type and each target saves when its field
// is committed. Presets replace them all; the current targets can be saved as a new preset.
// (Same bar rules as the routine's Volume Planning tab.)
function mountTargets(root: HTMLElement, signal: AbortSignal, db: Parameters<typeof saveProgressTarget>[0], presets: Preset[]) {
  const list = root.querySelector<HTMLElement>("#progress-targets")!;
  const rows = [...list.children] as HTMLElement[];
  const inputOf = (row: HTMLElement) => row.querySelector<HTMLInputElement>(".mv-target")!;
  const readTarget = (input: HTMLInputElement) => {
    const raw = input.value.trim();
    const n = Number(raw);
    return raw === "" || !Number.isFinite(n) || n < 0 ? null : n;
  };

  function render(row: HTMLElement) {
    const week = Number(row.dataset.week);
    const total = Number(row.dataset.totalRange);
    const target = readTarget(inputOf(row));
    const hasMin = target != null && target > 0;
    const parts = total ? [`${truncate1(total)} total in range`] : [];
    if (hasMin && week > target) parts.push(`+${truncate1(week - target)} above`);
    row.querySelector("[data-detail]")!.textContent = parts.join(" · ");
    row.querySelector<HTMLElement>(".mv-bar span")!.style.width = `${hasMin ? Math.min(1, week / target) * 100 : 0}%`;
    row.classList.toggle("no-target", !hasMin);
    row.classList.toggle("met", hasMin && week >= target);
    row.classList.toggle("none", week === 0 && !hasMin);
  }
  rows.forEach(render);

  list.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    input.classList.remove("invalid");
    render(input.closest("li")!);
  }, { signal });
  list.addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const row = input.closest<HTMLElement>("li")!;
    try {
      const saved = await saveProgressTarget(db, Number(row.dataset.id), row.dataset.name!, input.value);
      if (document.activeElement !== input) input.value = saved == null ? "" : formatNumber(saved);
    } catch (err) {
      input.classList.add("invalid");
      flash((err as Error).message, true);
      await refresh();
    }
  }, { signal });

  const sheet = root.querySelector<HTMLDialogElement>("#preset-sheet")!;
  root.querySelector("#open-presets")!.addEventListener("click", () => sheet.showModal(), { signal });
  sheet.addEventListener("click", async (e) => {
    const t = e.target as Element;
    if (t === sheet || t.closest("[data-close]")) return sheet.close();
    const btn = t.closest<HTMLElement>("[data-preset]");
    if (!btn) return;
    const preset = presets.find((pr) => pr.id === Number(btn.dataset.preset))!;
    await replaceProgressTargets(db, preset.sets);
    flash(`Loaded “${preset.name}”.`);
    await refresh();
  }, { signal });

  const saveForm = root.querySelector<HTMLFormElement>("#save-preset")!;
  saveForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(rows.map((row) => [Number(row.dataset.id), inputOf(row).value]));
    const result = await savePreset(db, null, root.querySelector<HTMLInputElement>("#preset-name")!.value, values);
    if (result.ok) flash(`Saved preset “${result.name}”.`);
    else flash(result.errors.join(" "), true);
    await refresh();
  }, { signal });
}
