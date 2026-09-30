// Routine editor: the routine is an ordered array of workout ids (repeats allowed),
// re-rendered on every change and serialized into the hidden "workout_ids" field on submit.
// The Analytics tab totals sets per muscle group live from that array (each set counts
// MUSCLE_SET_WEIGHTS[role], primary 1 / ancillary 0.5), scales them to a week by
// 7 / cycle_days, and compares them with the per-muscle weekly target inputs. The cycle
// and target inputs are submitted with the form.
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
  const cycleInput = document.getElementById("cycle_days");
  // Values are cut off (truncated, not rounded) at one decimal: 8.1666 -> "8.1", 8 -> "8".
  // The epsilon keeps float noise like 8.1 * 10 = 80.99999 from dropping a tenth.
  const fmt = (n) => String(Math.trunc(n * 10 + 1e-9) / 10);

  // Days for one pass through the routine; values scale by 7 / days to weekly. Invalid -> 7.
  function cycleDays() {
    const n = Number(cycleInput.value);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 7;
  }

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
    const scale = 7 / cycleDays();
    document.querySelector("[data-cycle-echo]").textContent = cycleDays();
    for (const row of volumeList.children) {
      const c = raw.get(row.dataset.muscle) || { primary: 0, ancillary: 0 };
      const primary = c.primary * scale;
      const ancillary = c.ancillary * scale;
      const total = primary * weights.primary + ancillary * weights.ancillary;
      const target = readTarget(row.querySelector(".mv-target"));
      row.querySelector("[data-total]").textContent = fmt(total);
      const parts = [];
      if (primary) parts.push(`${fmt(primary)} primary`);
      if (ancillary) parts.push(`${fmt(ancillary)} ancillary`);
      // Targets are weekly minimums; 0 (or blank) means no minimum, so no bar.
      const hasMin = target != null && target > 0;
      if (hasMin && total > target) parts.push(`+${fmt(total - target)} above`);
      row.querySelector("[data-detail]").textContent = parts.join(" · ");
      row.querySelector(".mv-bar span").style.width = `${hasMin ? Math.min(1, total / target) * 100 : 0}%`;
      row.classList.toggle("no-target", !hasMin);
      row.classList.toggle("met", hasMin && total >= target);
      row.classList.toggle("none", total === 0 && !hasMin);
    }
  }

  cycleInput.addEventListener("input", () => {
    cycleInput.value = cycleInput.value.replace(/\D/g, "");
    cycleInput.classList.remove("invalid");
    renderAnalytics();
  });

  volumeList.addEventListener("input", (e) => {
    if (e.target.classList.contains("mv-target")) {
      e.target.classList.remove("invalid");
      renderAnalytics();
    }
  });

  // ----- Presets -----
  // A preset fills every target input (a muscle it lacks gets 0). Nothing is saved until
  // "Save routine". Leaving for the preset page (new/edit) stashes the unsaved routine in
  // sessionStorage; it's restored when you come back to this page.

  const presets = JSON.parse(document.getElementById("target-presets").textContent);
  const presetSheet = document.getElementById("preset-sheet");
  const presetStatus = document.getElementById("preset-status");
  const DRAFT_KEY = `fitapp.routineDraft:${location.pathname}`;
  const targetInputs = () => [...volumeList.querySelectorAll(".mv-target")];
  const nameInput = document.getElementById("name");

  document.getElementById("open-presets").addEventListener("click", () => presetSheet.showModal());
  presetSheet.addEventListener("click", (e) => {
    if (e.target === presetSheet || e.target.closest("[data-close]")) return presetSheet.close();
    const btn = e.target.closest("[data-preset]");
    if (!btn) return;
    const preset = presets.find((p) => p.id === Number(btn.dataset.preset));
    for (const input of targetInputs()) {
      input.value = String(preset.sets[input.name.replace("target-", "")] ?? 0);
      input.classList.remove("invalid");
    }
    presetStatus.textContent = `Applied “${preset.name}”. Save the routine to keep it.`;
    presetSheet.close();
    renderAnalytics();
  });

  presetSheet.addEventListener("click", (e) => {
    if (!e.target.closest("[data-leave]")) return;
    const draft = {
      name: nameInput.value,
      ids: [...ids],
      cycle: cycleInput.value,
      targets: Object.fromEntries(targetInputs().map((i) => [i.name, i.value])),
    };
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* without storage, unsaved changes are simply lost */
    }
  });

  function restoreDraft() {
    let draft = null;
    try {
      draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
      sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      return false;
    }
    if (!draft) return false;
    nameInput.value = draft.name;
    ids.splice(0, ids.length, ...draft.ids.filter((id) => byId.has(id)));
    cycleInput.value = draft.cycle;
    for (const input of targetInputs()) if (input.name in draft.targets) input.value = draft.targets[input.name];
    return true;
  }

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

  const restored = restoreDraft();
  render();
  if (restored) showTab("analytics");
})();
