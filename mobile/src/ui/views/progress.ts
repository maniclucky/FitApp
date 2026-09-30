// Progress: daily volume chart and sets per muscle group over a date range. Ported from
// templates/progress.html.
import { html } from "lit-html";
import { progressData, progressRange, rangePresets } from "../../logic/progress";
import { formatVolume, historyDate, truncate1 } from "../../logic/text";
import { flash, href, navigate, route } from "../app";
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
        <h2>Sets per muscle group</h2>
        <p class="hint">Completed sets in this range: primary muscle 1 per set, ancillary 0.5. Per week = total × 7 ÷ ${p.nDays} days.</p>
        <table class="muscle-sets">
          <thead><tr><th scope="col">Muscle group</th><th scope="col">Total</th><th scope="col">Per week</th></tr></thead>
          <tbody>
            ${p.muscles.map((m) => html`
              <tr class=${m.total ? "" : "none"}><th scope="row">${m.name}</th><td>${truncate1(m.total)}</td><td>${truncate1(m.per_week)}</td></tr>`)}
          </tbody>
        </table>
      </section>`,
    mount(root: HTMLElement, signal: AbortSignal) {
      const chart = root.querySelector<HTMLElement>("#volume-chart");
      if (chart) mountVolumeChart(chart, p.days, signal);
      const form = root.querySelector<HTMLFormElement>("#range-form")!;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const data = new FormData(form);
        navigate(href("/progress", { start: String(data.get("start") ?? ""), end: String(data.get("end") ?? "") }));
      }, { signal });
    },
  };
});
