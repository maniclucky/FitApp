// Routine editor: the routine is an ordered array of workout ids (repeats allowed),
// re-rendered on every change and serialized into the hidden "workout_ids" field on submit.
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
  }

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
