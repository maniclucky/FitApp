// Workout builder: the workout lives in `items` and is re-rendered on structural
// changes. Typing in rep fields updates state in place so focus isn't lost.
// On submit, `items` is serialized into the hidden "items" field.
//
// items: [{ exercise_id, superset_next, sets: [{ min, max, amrap }] }]
// superset_next links an exercise to the one after it (chains allowed).
//
// Autofill: the first value typed into an exercise's min (or max) column is
// mirrored into that column on its other non-AMRAP sets as you type. Once that
// field is committed (blur), the column is "filled" and later edits stay put.
// filled is client-only; the server ignores it.
(function () {
  const DEFAULT_SET_COUNT = 3;

  const options = JSON.parse(document.getElementById("exercise-options").textContent);
  const byId = new Map(options.map((o) => [o.id, o]));
  const items = JSON.parse(document.getElementById("initial-items").textContent)
    .filter((it) => byId.has(it.exercise_id));
  // Loaded workouts (edit / failed save): a column that already has values counts as filled.
  for (const it of items) {
    it.filled = {
      min: it.sets.some((st) => st.min != null),
      max: it.sets.some((st) => st.max != null),
    };
  }

  const list = document.getElementById("builder-list");
  const empty = document.getElementById("builder-empty");
  const picker = document.getElementById("picker");

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const tracksReps = (item) => byId.get(item.exercise_id).modes.includes("reps");
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // ----- Rendering -----

  function setRow(item, i, set, s) {
    const removeBtn = `<button type="button" class="icon-btn" data-act="remove-set" data-i="${i}" data-s="${s}"
        aria-label="Remove set ${s + 1}" ${item.sets.length === 1 ? "disabled" : ""}>&times;</button>`;
    if (!tracksReps(item)) {
      const modes = byId.get(item.exercise_id).modes.join(" / ");
      return `<li class="set-row no-reps"><span class="set-num">${s + 1}</span>
        <span class="set-note">Log ${esc(modes)}</span>${removeBtn}</li>`;
    }
    const val = (v) => (v == null ? "" : esc(v));
    const invalid = set.min != null && set.max != null && Number(set.min) > Number(set.max);
    return `<li class="set-row${invalid ? " invalid" : ""}">
      <span class="set-num">${s + 1}</span>
      <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" data-field="min" data-i="${i}" data-s="${s}"
        value="${val(set.min)}" placeholder="${set.amrap ? "—" : "min"}" aria-label="Set ${s + 1} minimum reps" ${set.amrap ? "disabled" : ""}>
      <span class="range-dash">–</span>
      <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" data-field="max" data-i="${i}" data-s="${s}"
        value="${val(set.max)}" placeholder="${set.amrap ? "—" : "max"}" aria-label="Set ${s + 1} maximum reps" ${set.amrap ? "disabled" : ""}>
      <label class="mini-toggle">
        <input type="checkbox" data-field="amrap" data-i="${i}" data-s="${s}" ${set.amrap ? "checked" : ""}>
        <span>AMRAP</span>
      </label>
      ${removeBtn}
    </li>`;
  }

  function card(item, i) {
    const ex = byId.get(item.exercise_id);
    const inSuperset = item.superset_next || (i > 0 && items[i - 1].superset_next);
    const classes = ["wx-card"];
    if (inSuperset) classes.push("in-superset");
    if (i > 0 && items[i - 1].superset_next) classes.push("linked-above");
    if (item.superset_next) classes.push("linked-below");
    const badges = ex.modes.map((m) => `<span class="badge">${cap(m)}</span>`).join("");
    const header = tracksReps(item)
      ? `<div class="set-head"><span>Set</span><span>Reps (optional range)</span></div>`
      : "";
    return `<li class="${classes.join(" ")}">
      <div class="wx-head">
        <div class="wx-title"><h3>${esc(ex.name)}</h3><div class="badges">${badges}</div></div>
        <div class="wx-actions">
          <button type="button" class="icon-btn" data-act="up" data-i="${i}" aria-label="Move ${esc(ex.name)} up" ${i === 0 ? "disabled" : ""}>&uarr;</button>
          <button type="button" class="icon-btn" data-act="down" data-i="${i}" aria-label="Move ${esc(ex.name)} down" ${i === items.length - 1 ? "disabled" : ""}>&darr;</button>
          <button type="button" class="icon-btn danger" data-act="remove" data-i="${i}" aria-label="Remove ${esc(ex.name)}">&times;</button>
        </div>
      </div>
      ${header}
      <ol class="sets">${item.sets.map((set, s) => setRow(item, i, set, s)).join("")}</ol>
      <button type="button" class="button subtle small" data-act="add-set" data-i="${i}">+ Add set</button>
    </li>`;
  }

  function link(i) {
    const on = items[i].superset_next;
    return `<li class="superset-link${on ? " on" : ""}">
      <label class="link-toggle">
        <input type="checkbox" data-act="superset" data-i="${i}" ${on ? "checked" : ""}>
        <span>${on ? "Supersetted" : "Superset"}</span>
      </label>
    </li>`;
  }

  function render() {
    list.innerHTML = items.map((item, i) => card(item, i) + (i < items.length - 1 ? link(i) : "")).join("");
    empty.hidden = items.length > 0;
  }

  // ----- State changes -----

  // A link after the last exercise is meaningless and would silently re-link
  // whatever gets added next, so always clear it.
  function tidyLinks() {
    if (items.length) items[items.length - 1].superset_next = false;
  }

  function newSet(prev) {
    return prev ? { ...prev } : { min: null, max: null, amrap: false };
  }

  function addExercise(id) {
    items.push({
      exercise_id: id,
      superset_next: false,
      sets: Array.from({ length: DEFAULT_SET_COUNT }, () => newSet()),
      filled: { min: false, max: false },
    });
    render();
  }

  // Moving an exercise pulls it out of any superset; the user re-links where wanted.
  function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    items[i].superset_next = false;
    if (i > 0) items[i - 1].superset_next = false;
    [items[i], items[j]] = [items[j], items[i]];
    tidyLinks();
    render();
    const btn = list.querySelector(`[data-act="${delta < 0 ? "up" : "down"}"][data-i="${j}"]`);
    (btn && !btn.disabled ? btn : list.querySelector(`[data-act="remove"][data-i="${j}"]`)).focus();
  }

  list.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    switch (btn.dataset.act) {
      case "up": return move(i, -1);
      case "down": return move(i, 1);
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
        const inputs = list.querySelectorAll(`[data-field="min"][data-i="${i}"]`);
        if (inputs.length && !inputs[inputs.length - 1].disabled) inputs[inputs.length - 1].focus();
        return;
      }
      case "remove-set":
        items[i].sets.splice(Number(btn.dataset.s), 1);
        return render();
    }
  });

  function markValidity(i, s) {
    const set = items[i].sets[s];
    const row = list.querySelector(`[data-field="min"][data-i="${i}"][data-s="${s}"]`)?.closest(".set-row");
    if (row) row.classList.toggle("invalid", set.min != null && set.max != null && set.min > set.max);
  }

  list.addEventListener("input", (e) => {
    const el = e.target;
    const { field } = el.dataset;
    if (field !== "min" && field !== "max") return;
    el.value = el.value.replace(/\D/g, "");
    const i = Number(el.dataset.i);
    const s = Number(el.dataset.s);
    const item = items[i];
    const value = el.value === "" ? null : Number(el.value);
    item.sets[s][field] = value;
    markValidity(i, s);

    if (!item.filled[field]) {
      item.sets.forEach((set, t) => {
        if (t === s || set.amrap) return;
        set[field] = value;
        const input = list.querySelector(`[data-field="${field}"][data-i="${i}"][data-s="${t}"]`);
        if (input) input.value = value ?? "";
        markValidity(i, t);
      });
    }
  });

  // Committing a non-empty first entry ends autofill for that column.
  list.addEventListener("focusout", (e) => {
    const { field } = e.target.dataset;
    if (field !== "min" && field !== "max") return;
    const item = items[Number(e.target.dataset.i)];
    if (item && item.sets[Number(e.target.dataset.s)]?.[field] != null) item.filled[field] = true;
  });

  list.addEventListener("change", (e) => {
    const el = e.target;
    const i = Number(el.dataset.i);
    if (el.dataset.act === "superset") {
      items[i].superset_next = el.checked;
      render();
      list.querySelector(`[data-act="superset"][data-i="${i}"]`).focus();
    } else if (el.dataset.field === "amrap") {
      const set = items[i].sets[Number(el.dataset.s)];
      set.amrap = el.checked;
      if (set.amrap) set.min = set.max = null;
      render();
      list.querySelector(`[data-field="amrap"][data-i="${i}"][data-s="${el.dataset.s}"]`).focus();
    }
  });

  // ----- Exercise picker (bottom sheet) -----

  const pickerList = document.getElementById("picker-list");
  const filterRoot = picker.querySelector("[data-exercise-filter]");
  const filter = filterRoot && window.ExerciseFilter(filterRoot, renderPicker);
  const none = document.getElementById("picker-none");

  function renderPicker() {
    if (!pickerList) return;
    const counts = new Map();
    for (const it of items) counts.set(it.exercise_id, (counts.get(it.exercise_id) || 0) + 1);
    const matches = options.filter(filter.matches);
    pickerList.innerHTML = matches.map((o) => {
      const n = counts.get(o.id);
      return `<li><button type="button" data-id="${o.id}">
        <span>${esc(o.name)}</span>
        <span class="picker-meta">${n ? `Added${n > 1 ? ` ×${n}` : ""}` : esc(o.modes.map(cap).join(" · "))}</span>
      </button></li>`;
    }).join("");
    none.hidden = matches.length > 0;
  }

  document.getElementById("open-picker").addEventListener("click", () => {
    filter?.reset();
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
      addExercise(Number(btn.dataset.id));
      renderPicker();
    });
  }

  // ----- Submit -----

  document.getElementById("builder-form").addEventListener("submit", () => {
    document.getElementById("items-input").value = JSON.stringify(items);
  });

  render();
})();

