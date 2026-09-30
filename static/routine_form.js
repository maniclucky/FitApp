// Routine editor: the routine is an ordered array of workout ids (repeats allowed),
// re-rendered on every change and serialized into the hidden "workout_ids" field on submit.
// The Analytics tab totals sets per muscle group live from that array (each set counts
// MUSCLE_SET_WEIGHTS[role], primary 1 / ancillary 0.5) and compares them with the per-muscle
// target inputs, which are submitted with the form.
(function () {
  const options = JSON.parse(document.getElementById("workout-options").textContent);
  const byId = new Map(options.map((o) => [o.id, o]));
  const ids = JSON.parse(document.getElementById("initial-workout-ids").textContent)
    .filter((id) => byId.has(id));

  const list = document.getElementById("routine-list");
  const empty = document.getElementById("routine-empty");
  const picker = document.getElementById("picker");
  const pickerList = document.getElementById("picker-list");

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function render() {
    list.innerHTML = ids.map((id, i) => {
      const w = byId.get(id);
      return `<li class="wx-card routine-item">
        <span class="routine-num">${i + 1}</span>
        <div class="wx-title"><h3>${esc(w.name)}</h3><span class="picker-meta">${plural(w.count, "exercise")}</span></div>
        <div class="wx-actions">
          <button type="button" class="icon-btn" data-act="up" data-i="${i}" aria-label="Move ${esc(w.name)} up" ${i === 0 ? "disabled" : ""}>&uarr;</button>
          <button type="button" class="icon-btn" data-act="down" data-i="${i}" aria-label="Move ${esc(w.name)} down" ${i === ids.length - 1 ? "disabled" : ""}>&darr;</button>
          <button type="button" class="icon-btn danger" data-act="remove" data-i="${i}" aria-label="Remove ${esc(w.name)}">&times;</button>
        </div>
      </li>`;
    }).join("");
    empty.hidden = ids.length > 0;
    renderAnalytics();
  }

  // ----- Analytics -----
  // Rows and target inputs are server-rendered (so they submit with the form); this only
  // updates the totals and bars. A bar fills toward the row's target and turns amber past
  // it; with no target there's nothing to fill toward, so the bar is hidden.

  const weights = JSON.parse(document.getElementById("muscle-set-weights").textContent);
  const volumeList = document.getElementById("muscle-volume");
  const fmt = (n) => String(Math.round(n * 100) / 100);

  function readTarget(input) {
    const raw = input.value.trim();
    const n = Number(raw);
    return raw === "" || !Number.isFinite(n) || n < 0 ? null : n;
  }

  function renderAnalytics() {
    const raw = new Map();
    for (const id of ids) {
      for (const [muscle, counts] of Object.entries(byId.get(id).muscles)) {
        const c = raw.get(muscle) || { primary: 0, ancillary: 0 };
        c.primary += counts.primary;
        c.ancillary += counts.ancillary;
        raw.set(muscle, c);
      }
    }
    for (const row of volumeList.children) {
      const c = raw.get(row.dataset.muscle) || { primary: 0, ancillary: 0 };
      const total = c.primary * weights.primary + c.ancillary * weights.ancillary;
      const target = readTarget(row.querySelector(".mv-target"));
      row.querySelector("[data-total]").textContent = fmt(total);
      const parts = [];
      if (c.primary) parts.push(`${c.primary} primary`);
      if (c.ancillary) parts.push(`${c.ancillary} ancillary`);
      if (target != null && total > target) parts.push(`${fmt(total - target)} over`);
      row.querySelector("[data-detail]").textContent = parts.join(" · ");
      const fill = target == null ? 0 : target === 0 ? (total > 0 ? 1 : 0) : Math.min(1, total / target);
      row.querySelector(".mv-bar span").style.width = `${fill * 100}%`;
      row.classList.toggle("no-target", target == null);
      row.classList.toggle("met", target != null && total >= target);
      row.classList.toggle("over", target != null && total > target);
      row.classList.toggle("none", total === 0 && target == null);
    }
  }

  volumeList.addEventListener("input", (e) => {
    if (e.target.classList.contains("mv-target")) {
      e.target.classList.remove("invalid");
      renderAnalytics();
    }
  });

  // ----- Tabs -----

  const tabs = [...document.querySelectorAll("[data-tab]")];
  function showTab(key) {
    for (const tab of tabs) {
      const on = tab.dataset.tab === key;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      document.getElementById(`panel-${tab.dataset.tab}`).hidden = !on;
    }
  }
  for (const tab of tabs) tab.addEventListener("click", () => showTab(tab.dataset.tab));
  tabs[0].parentElement.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next.dataset.tab);
    next.focus();
  });

  list.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if (btn.dataset.act === "remove") {
      ids.splice(i, 1);
      return render();
    }
    const j = i + (btn.dataset.act === "up" ? -1 : 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    render();
    const next = list.querySelector(`[data-act="${btn.dataset.act}"][data-i="${j}"]`);
    (next && !next.disabled ? next : list.querySelector(`[data-act="remove"][data-i="${j}"]`)).focus();
  });

  // ----- Workout picker (bottom sheet) -----

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

  document.getElementById("open-picker").addEventListener("click", () => {
    renderPicker();
    picker.showModal();
  });
  document.getElementById("close-picker").addEventListener("click", () => picker.close());
  picker.addEventListener("click", (e) => {
    if (e.target === picker) picker.close(); // tap on backdrop
  });
  if (pickerList) {
    pickerList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-id]");
      if (!btn) return;
      ids.push(Number(btn.dataset.id));
      render();
      renderPicker();
    });
  }

  document.getElementById("routine-form").addEventListener("submit", () => {
    document.getElementById("workout-ids-input").value = JSON.stringify(ids);
  });

  render();
})();
