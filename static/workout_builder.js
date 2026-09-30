// Workout builder: the workout lives in `items` and is re-rendered on structural
// changes. Typing in set fields updates state in place so focus isn't lost.
// On submit, `items` is serialized into the hidden "items" field.
//
// items: [{ exercise_id, superset_next, sets: [{ min, max, amrap, weight, time, distance }] }]
// superset_next links an exercise to the one after it (chains allowed). Each set has a
// field per mode the exercise tracks: a rep range (+ AMRAP), weight (lb), time, distance
// (mi). Weight/time/distance are kept as the text typed and parsed by the server; time
// accepts "1:30" or "130" (static/time_format.js).
//
// Autofill: the first value typed into a column (min, max, weight, time, distance) is
// mirrored into that column on the exercise's other sets as you type (rep columns skip
// AMRAP sets). Once that field is committed (blur), the column is "filled" and later
// edits stay put. filled is client-only; the server ignores it.
(function () {
  const DEFAULT_SET_COUNT = 3;
  const FIELDS = ["min", "max", "weight", "time", "distance"];
  const TEXT_FIELDS = ["weight", "time", "distance"];

  const options = JSON.parse(document.getElementById("exercise-options").textContent);
  const byId = new Map(options.map((o) => [o.id, o]));
  const items = JSON.parse(document.getElementById("initial-items").textContent)
    .filter((it) => byId.has(it.exercise_id));
  // Server values are numbers (time in seconds); the builder edits them as text.
  const asText = (field, v) => (v == null || v === "" ? null : field === "time" && typeof v === "number" ? FitTime.format(v) : String(v));
  for (const it of items) {
    for (const st of it.sets) for (const f of TEXT_FIELDS) st[f] = asText(f, st[f]);
    // Loaded workouts (edit / failed save): a column that already has values counts as filled.
    it.filled = Object.fromEntries(FIELDS.map((f) => [f, it.sets.some((st) => st[f] != null)]));
  }

  const list = document.getElementById("builder-list");
  const empty = document.getElementById("builder-empty");
  const picker = document.getElementById("picker");

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const modesOf = (item) => byId.get(item.exercise_id).modes;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // ----- Rendering -----

  // One grid column per tracked mode, in TRACKING_MODES order (like the day view).
  const COLUMNS = {
    weight: { tracks: "minmax(0, 1fr)", heads: ["lb"] },
    reps: { tracks: "minmax(0, 2fr) auto", heads: ["Reps", ""] },
    time: { tracks: "minmax(0, 1fr)", heads: ["Time"] },
    distance: { tracks: "minmax(0, 1fr)", heads: ["mi"] },
  };
  const gridColumns = (item) => ["28px", ...modesOf(item).map((m) => COLUMNS[m].tracks), "40px"].join(" ");

  const timeInvalid = (set) => set.time != null && Number.isNaN(FitTime.parse(set.time));
  const rangeInvalid = (set) => set.min != null && set.max != null && Number(set.min) > Number(set.max);

  function textInput(field, i, s, set, { inputmode, label, placeholder = "–", invalid = false }) {
    return `<input type="text" inputmode="${inputmode}" maxlength="7" data-field="${field}" data-i="${i}" data-s="${s}"
      class="${invalid ? "invalid" : ""}" value="${set[field] == null ? "" : esc(set[field])}"
      placeholder="${placeholder}" aria-label="Set ${s + 1} ${label}" autocomplete="off">`;
  }

  function setRow(item, i, set, s) {
    const cells = modesOf(item).map((m) => {
      if (m === "weight") return textInput("weight", i, s, set, { inputmode: "decimal", label: "weight in pounds" });
      if (m === "time") {
        return textInput("time", i, s, set, { inputmode: "numeric", label: "time", placeholder: "m:ss", invalid: timeInvalid(set) });
      }
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

  function card(item, i) {
    const ex = byId.get(item.exercise_id);
    const inSuperset = item.superset_next || (i > 0 && items[i - 1].superset_next);
    const classes = ["wx-card"];
    if (inSuperset) classes.push("in-superset");
    if (i > 0 && items[i - 1].superset_next) classes.push("linked-above");
    if (item.superset_next) classes.push("linked-below");
    const badges = ex.modes.map((m) => `<span class="badge">${cap(m)}</span>`).join("");
    const heads = ["Set", ...ex.modes.flatMap((m) => COLUMNS[m].heads), ""];
    return `<li class="${classes.join(" ")}">
      <div class="wx-head">
        <div class="wx-title"><h3>${esc(ex.name)}</h3><div class="badges">${badges}</div></div>
        <div class="wx-actions">
          <button type="button" class="icon-btn" data-act="up" data-i="${i}" aria-label="Move ${esc(ex.name)} up" ${i === 0 ? "disabled" : ""}>&uarr;</button>
          <button type="button" class="icon-btn" data-act="down" data-i="${i}" aria-label="Move ${esc(ex.name)} down" ${i === items.length - 1 ? "disabled" : ""}>&darr;</button>
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
    return prev ? { ...prev } : { min: null, max: null, amrap: false, weight: null, time: null, distance: null };
  }

  function addExercise(id) {
    items.push({
      exercise_id: id,
      superset_next: false,
      sets: Array.from({ length: DEFAULT_SET_COUNT }, () => newSet()),
      filled: Object.fromEntries(FIELDS.map((f) => [f, false])),
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
    const q = (f) => list.querySelector(`[data-field="${f}"][data-i="${i}"][data-s="${s}"]`);
    for (const f of ["min", "max"]) q(f)?.classList.toggle("invalid", rangeInvalid(set));
    q("time")?.classList.toggle("invalid", timeInvalid(set));
  }

  const SANITIZE = { min: /\D/g, max: /\D/g, weight: /[^\d.]/g, distance: /[^\d.]/g, time: /[^\d:]/g };

  list.addEventListener("input", (e) => {
    const el = e.target;
    const { field } = el.dataset;
    if (!FIELDS.includes(field)) return;
    el.value = el.value.replace(SANITIZE[field], "");
    const i = Number(el.dataset.i);
    const s = Number(el.dataset.s);
    const item = items[i];
    const value = el.value === "" ? null : TEXT_FIELDS.includes(field) ? el.value : Number(el.value);
    item.sets[s][field] = value;
    markValidity(i, s);

    if (!item.filled[field]) {
      const repField = field === "min" || field === "max";
      item.sets.forEach((set, t) => {
        if (t === s || (repField && set.amrap)) return;
        set[field] = value;
        const input = list.querySelector(`[data-field="${field}"][data-i="${i}"][data-s="${t}"]`);
        if (input) input.value = value ?? "";
        markValidity(i, t);
      });
    }
  });

  // Committing a non-empty first entry ends autofill for that column. Readable times are
  // tidied to m:ss across the exercise (autofilled copies included).
  list.addEventListener("focusout", (e) => {
    const { field } = e.target.dataset;
    if (!FIELDS.includes(field)) return;
    const i = Number(e.target.dataset.i);
    const item = items[i];
    if (!item) return;
    if (item.sets[Number(e.target.dataset.s)]?.[field] != null) item.filled[field] = true;
    if (field === "time") {
      item.sets.forEach((set, t) => {
        const sec = set.time == null ? null : FitTime.parse(set.time);
        if (sec == null || Number.isNaN(sec)) return;
        set.time = FitTime.format(sec);
        const input = list.querySelector(`[data-field="time"][data-i="${i}"][data-s="${t}"]`);
        if (input) input.value = set.time;
      });
    }
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

