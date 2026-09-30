// Day view: autosaving set fields, completion checks, add/remove sets, the "+ Add" sheet
// (routines/workouts/exercises), per-exercise history, long-press reordering, the history
// calendar, and swipe (or arrow-key) navigation.
// Field edits save in place; structural changes reload the page (scroll is kept).
(function () {
  const day = document.getElementById("day");
  const toastEl = document.getElementById("toast");
  const dayUrl = (iso) => day.dataset.dayUrl.replace("DATE", iso);

  // ---------- helpers ----------

  let toastTimer = null;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 3500);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || "Something went wrong. Please try again.");
    return data;
  }

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- set fields ----------

  const { parse: parseTime, format: fmtTime } = window.FitTime;

  function readField(input) {
    const raw = input.value.trim();
    if (input.dataset.field === "duration_seconds") {
      const sec = parseTime(raw);
      if (Number.isNaN(sec)) throw new Error("Time should look like 1:30 (or type 130).");
      return sec;
    }
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error("Please enter a positive number.");
    return n;
  }

  function showField(input, value) {
    if (value == null) input.value = "";
    else if (input.dataset.field === "duration_seconds") input.value = fmtTime(value);
    else input.value = String(value);
  }

  function applySet(row, data) {
    for (const input of row.querySelectorAll("input[data-field]")) {
      if (document.activeElement !== input) showField(input, data[input.dataset.field]);
      input.classList.remove("invalid");
    }
    row.classList.toggle("done", data.completed);
    row.querySelector(".check").setAttribute("aria-pressed", String(data.completed));
  }

  day.addEventListener("change", async (e) => {
    const input = e.target.closest("input[data-field]");
    if (!input) return;
    const row = input.closest("[data-set]");
    let value;
    try {
      value = readField(input);
    } catch (err) {
      input.classList.add("invalid");
      return toast(err.message);
    }
    try {
      const data = await api("PATCH", `/api/sets/${row.dataset.set}`, { [input.dataset.field]: value });
      showField(input, data[input.dataset.field]);
      input.classList.remove("invalid");
    } catch (err) {
      input.classList.add("invalid");
      toast(err.message);
    }
  });

  // Completing sends the whole row, so values typed just before tapping ✓ are never lost.
  day.addEventListener("click", async (e) => {
    const check = e.target.closest(".check");
    if (!check) return;
    const row = check.closest("[data-set]");
    const completed = check.getAttribute("aria-pressed") !== "true";
    const body = { completed };
    try {
      for (const input of row.querySelectorAll("input[data-field]")) body[input.dataset.field] = readField(input);
    } catch (err) {
      return toast(err.message);
    }
    check.disabled = true;
    try {
      const data = await api("PATCH", `/api/sets/${row.dataset.set}`, body);
      applySet(row, data);
      if (data.completed && row.dataset.rest === "1" && window.RestTimer) window.RestTimer.onSetCompleted();
    } catch (err) {
      toast(err.message);
    } finally {
      check.disabled = false;
    }
  });

  // ---------- add / remove sets ----------

  day.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const lx = btn.dataset.lx;
    btn.disabled = true;
    try {
      if (btn.dataset.act === "add-set") await api("POST", `/api/log-exercises/${lx}/sets`);
      else if (btn.dataset.act === "remove-set") await api("DELETE", `/api/log-exercises/${lx}/sets/last`);
      else return;
      location.reload();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });

  // ---------- sheets ----------

  function wireSheet(sheet, onClose) {
    sheet.addEventListener("click", (e) => {
      if (e.target === sheet || e.target.closest("[data-close]")) sheet.close();
    });
    if (onClose) sheet.addEventListener("close", onClose);
  }

  // One "+ Add" sheet with Routines / Workouts / Exercises tabs. Routines and workouts expand
  // to a preview with a Load button that returns to the day; exercises are multi-select.
  const addSheet = document.getElementById("add-sheet");
  const tabs = [...addSheet.querySelectorAll("[data-tab]")];
  const TAB_KEY = "fitapp.addTab";
  wireSheet(addSheet);

  function showTab(key) {
    for (const tab of tabs) {
      const on = tab.dataset.tab === key;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      document.getElementById(`panel-${tab.dataset.tab}`).hidden = !on;
    }
    try {
      localStorage.setItem(TAB_KEY, key);
    } catch {
      /* remembering the tab is a convenience only */
    }
  }

  addSheet.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) showTab(tab.dataset.tab);
  });
  addSheet.querySelector(".segmented").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next.dataset.tab);
    next.focus();
  });

  document.getElementById("open-add").addEventListener("click", () => {
    let key = null;
    try {
      key = localStorage.getItem(TAB_KEY);
    } catch {
      /* ignore */
    }
    if (!tabs.some((t) => t.dataset.tab === key)) key = "routines";
    selected.length = 0;
    exFilter?.reset();
    renderExercisePicker();
    for (const item of addSheet.querySelectorAll(".pick-item.expanded")) setExpanded(item, false);
    showTab(key);
    addSheet.showModal();
  });

  // Routines and workouts expand (one at a time) to preview the workout's exercises and
  // set counts, with a Load button. A routine previews the workout it would load; ↻ steps
  // through its workouts to override the suggested one.
  const summaries = JSON.parse(document.getElementById("workout-summaries").textContent);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function renderSummary(item) {
    const w = summaries[JSON.parse(item.dataset.workouts)[Number(item.dataset.index)]];
    const line = (ex) => `<li><span>${esc(ex.name)}</span><span class="set-summary">${plural(ex.sets, "set")}</span></li>`;
    item.querySelector("[data-summary]").innerHTML = w.blocks
      .map((block) => block.length > 1
        ? `<li class="superset-block"><span class="superset-tag">Superset</span><ol>${block.map(line).join("")}</ol></li>`
        : line(block[0]))
      .join("");
    if (item.dataset.kind === "routines") item.querySelector("[data-load]").textContent = `Load ${w.name}`;
  }

  function setExpanded(item, open) {
    item.querySelector(".pick-toggle").setAttribute("aria-expanded", String(open));
    item.querySelector(".pick-detail").hidden = !open;
    item.classList.toggle("expanded", open);
    if (open) renderSummary(item);
  }

  function expand(item) {
    for (const other of addSheet.querySelectorAll(".pick-item.expanded")) if (other !== item) setExpanded(other, false);
    setExpanded(item, true);
  }

  addSheet.addEventListener("click", (e) => {
    const toggle = e.target.closest(".pick-toggle");
    if (!toggle) return;
    const item = toggle.closest(".pick-item");
    if (item.classList.contains("expanded")) setExpanded(item, false);
    else expand(item);
  });

  addSheet.addEventListener("click", (e) => {
    const cycle = e.target.closest("[data-cycle]");
    if (!cycle) return;
    const item = cycle.closest(".pick-item");
    const ids = JSON.parse(item.dataset.workouts);
    const index = (Number(item.dataset.index) + 1) % ids.length;
    const overridden = index !== Number(item.dataset.suggested);
    item.dataset.index = index;
    item.classList.toggle("overridden", overridden);
    item.querySelector("[data-pick-label]").textContent = overridden ? "Picked" : "Next";
    item.querySelector("[data-pick-name]").textContent = summaries[ids[index]].name;
    item.querySelector("[data-pick-pos]").textContent = `${index + 1} of ${ids.length}`;
    expand(item); // show what was picked
  });

  addSheet.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-load]");
    if (!btn) return;
    const item = btn.closest(".pick-item");
    const id = Number(item.dataset.id);
    const body = item.dataset.kind === "routines"
      ? { routine_id: id, index: Number(item.dataset.index) }
      : { workout_id: id };
    btn.disabled = true;
    try {
      await api("POST", `/api/day/${day.dataset.date}/${item.dataset.kind}`, body);
      location.reload();
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
    }
  });

  const options = JSON.parse(document.getElementById("exercise-options").textContent);
  const exList = document.getElementById("exercise-list");
  const filterRoot = addSheet.querySelector("[data-exercise-filter]");
  const exFilter = filterRoot && window.ExerciseFilter(filterRoot, renderExercisePicker);
  const exNone = document.getElementById("exercise-none");
  const exAdd = document.getElementById("add-exercises");
  const selected = []; // exercise ids, in the order they were picked

  function renderExercisePicker() {
    if (!exList) return;
    const matches = options.filter(exFilter.matches);
    exList.innerHTML = matches
      .map((o) => {
        const n = selected.indexOf(o.id) + 1;
        const modes = o.modes.map((m) => m[0].toUpperCase() + m.slice(1)).join(" · ");
        return `<li><button type="button" role="checkbox" aria-checked="${n > 0}" data-exercise-id="${o.id}">
          <span class="pick-box" aria-hidden="true">${n || ""}</span>
          <span class="pick-name">${esc(o.name)}</span>
          <span class="picker-meta">${esc(modes)}</span></button></li>`;
      })
      .join("");
    exNone.hidden = matches.length > 0;
    exAdd.disabled = selected.length === 0;
    exAdd.textContent = selected.length
      ? `Add ${selected.length} exercise${selected.length === 1 ? "" : "s"}`
      : "Select exercises";
  }

  if (exList) {
    exList.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-exercise-id]");
      if (!btn) return;
      const id = Number(btn.dataset.exerciseId);
      const i = selected.indexOf(id);
      if (i >= 0) selected.splice(i, 1);
      else selected.push(id);
      renderExercisePicker();
      exList.querySelector(`[data-exercise-id="${id}"]`)?.focus();
    });
    exAdd.addEventListener("click", async () => {
      exAdd.disabled = true;
      try {
        await api("POST", `/api/day/${day.dataset.date}/exercises`, { exercise_ids: [...selected] });
        location.reload();
      } catch (err) {
        exAdd.disabled = false;
        toast(err.message);
      }
    });
  }

  // ---------- exercise history ----------
  // The History button on each card opens a sheet listing that exercise's sessions
  // before this day (server-rendered: templates/_exercise_history.html).

  const historySheet = document.getElementById("history-sheet");
  const historyBody = document.getElementById("history-body");
  let historyRequest = 0;
  wireSheet(historySheet);

  day.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-history]");
    if (!btn) return;
    const request = ++historyRequest;
    document.getElementById("history-sheet-title").textContent = btn.dataset.name;
    historyBody.innerHTML = '<p class="empty small">Loading…</p>';
    historySheet.showModal();
    try {
      const res = await fetch(`/exercises/${btn.dataset.history}/history?before=${day.dataset.date}`);
      if (!res.ok) throw new Error();
      const html = await res.text();
      if (request === historyRequest) historyBody.innerHTML = html;
    } catch {
      if (request === historyRequest) historyBody.innerHTML = '<p class="empty small">Couldn’t load the history. Please try again.</p>';
    }
  });

  // ---------- long-press to reorder ----------
  // Press and hold an exercise (not on an input or button) to lift its block; a superset
  // moves as one block. Other blocks slide out of the way; dropping saves the new order.

  const LONG_PRESS_MS = 400;
  const MOVE_TOLERANCE = 8; // px of finger drift allowed while waiting for the long press
  const EDGE = 80; // px from the top/bottom of the viewport that auto-scrolls
  const logList = document.getElementById("log-list");
  let press = null; // waiting for the long press
  let drag = null; // a block is lifted

  function cancelPress() {
    if (press) clearTimeout(press.timer);
    press = null;
  }

  function startDrag() {
    const { block, y } = press;
    press = null;
    const blocks = [...logList.querySelectorAll(":scope > [data-block]")];
    const tops = blocks.map((b) => b.getBoundingClientRect().top + scrollY);
    const heights = blocks.map((b) => b.offsetHeight);
    const gap = parseFloat(getComputedStyle(logList).rowGap) || 0;
    const index = blocks.indexOf(block);
    drag = { block, blocks, tops, heights, gap, index, target: index, pageY0: y + scrollY, clientY: y, raf: 0 };
    touch = null; // cancel any day swipe in progress
    day.style.transform = "";
    document.activeElement?.blur?.();
    logList.classList.add("reordering");
    block.classList.add("dragging");
    navigator.vibrate?.(12);
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function moveDrag() {
    const { block, blocks, tops, heights, gap, index } = drag;
    const dy = drag.clientY + scrollY - drag.pageY0;
    block.style.transform = `translateY(${dy}px) scale(1.02)`;
    const center = tops[index] + heights[index] / 2 + dy;
    let target = index;
    for (let j = 0; j < blocks.length; j++) {
      const mid = tops[j] + heights[j] / 2;
      if (j > index && center > mid) target = j;
      if (j < index && center < mid && target >= index) target = j;
    }
    drag.target = target;
    const shift = heights[index] + gap;
    blocks.forEach((b, j) => {
      if (j === index) return;
      const offset = j > index && j <= target ? -shift : j < index && j >= target ? shift : 0;
      b.style.transform = offset ? `translateY(${offset}px)` : "";
    });
  }

  function autoScroll() {
    if (!drag) return;
    const y = drag.clientY;
    const bottomEdge = innerHeight - EDGE - 72; // leave room for the timer bar and tab bar
    const speed = y < EDGE ? -(EDGE - y) / 5 : y > bottomEdge ? (y - bottomEdge) / 5 : 0;
    if (speed) {
      scrollBy(0, speed);
      moveDrag();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function endDrag() {
    const { block, blocks, tops, heights, index, target } = drag;
    cancelAnimationFrame(drag.raf);
    drag = null;
    // Glide the lifted block into its slot, then move it in the DOM and drop all transforms.
    const finalTop = target > index ? tops[target] + heights[target] - heights[index] : tops[target];
    block.classList.add("settling");
    block.style.transform = `translateY(${finalTop - tops[index]}px)`;
    setTimeout(() => {
      logList.classList.add("no-anim");
      block.classList.remove("dragging", "settling");
      for (const b of blocks) b.style.transform = "";
      if (target > index) blocks[target].after(block);
      else if (target < index) blocks[target].before(block);
      void logList.offsetHeight; // apply the reset before re-enabling transitions
      logList.classList.remove("no-anim", "reordering");
      if (target !== index) saveOrder();
    }, 160);
  }

  async function saveOrder() {
    const ids = [...logList.querySelectorAll(".log-card")].map((c) => Number(c.dataset.lx));
    try {
      await api("POST", `/api/day/${day.dataset.date}/order`, { log_exercise_ids: ids });
    } catch (err) {
      toast(err.message);
      setTimeout(() => location.reload(), 1500);
    }
  }

  if (logList) {
    logList.addEventListener("pointerdown", (e) => {
      if (drag || !e.isPrimary || e.button !== 0 || e.target.closest("input, button, a, label")) return;
      const block = e.target.closest("[data-block]");
      if (!block) return;
      cancelPress();
      press = { block, x: e.clientX, y: e.clientY, timer: setTimeout(startDrag, LONG_PRESS_MS) };
    });
    document.addEventListener("pointermove", (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
      if (drag && e.isPrimary) {
        drag.clientY = e.clientY;
        moveDrag();
      }
    });
    const release = () => {
      cancelPress();
      if (drag) endDrag();
    };
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", release);
    // While a block is lifted, the finger drags it instead of scrolling the page.
    document.addEventListener("touchmove", (e) => {
      if (drag && e.cancelable) e.preventDefault();
    }, { passive: false });
    // Long-pressing shouldn't pop the phone's context menu.
    logList.addEventListener("contextmenu", (e) => {
      if (press || drag) e.preventDefault();
    });
  }

  // ---------- calendar ----------

  const calSheet = document.getElementById("calendar-sheet");
  const calTitle = document.getElementById("cal-title");
  const calGrid = document.getElementById("cal-grid");
  wireSheet(calSheet);
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const [selY, selM] = day.dataset.date.split("-").map(Number);
  let calYear = selY;
  let calMonth = selM - 1; // 0-based
  let calRequest = 0;

  async function renderCalendar() {
    const request = ++calRequest;
    const first = new Date(calYear, calMonth, 1);
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    calTitle.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    let counts = {};
    try {
      counts = await api("GET", `/api/calendar?month=${calYear}-${pad(calMonth + 1)}`);
    } catch (err) {
      toast(err.message);
    }
    if (request !== calRequest) return; // a newer month was requested meanwhile

    const cells = ["S", "M", "T", "W", "T", "F", "S"].map((d) => `<span class="cal-dow" aria-hidden="true">${d}</span>`);
    for (let i = 0; i < first.getDay(); i++) cells.push("<span></span>");
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = isoOf(calYear, calMonth, d);
      const c = counts[iso];
      const classes = ["cal-day"];
      if (iso === day.dataset.today) classes.push("today");
      if (iso === day.dataset.date) classes.push("selected");
      let status = "";
      if (c) {
        const complete = c.sets > 0 && c.done === c.sets;
        classes.push(complete ? "complete" : "partial");
        status = complete ? ", all sets done" : `, ${c.done} of ${c.sets} sets done`;
      }
      const label = new Date(calYear, calMonth, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      cells.push(`<a class="${classes.join(" ")}" href="${dayUrl(iso)}" aria-label="${esc(label + status)}"
        ${iso === day.dataset.date ? 'aria-current="date"' : ""}>${d}</a>`);
    }
    calGrid.innerHTML = cells.join("");
  }

  document.getElementById("open-calendar").addEventListener("click", () => {
    calYear = selY;
    calMonth = selM - 1;
    renderCalendar();
    calSheet.showModal();
  });
  calSheet.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-month]");
    if (!btn) return;
    calMonth += Number(btn.dataset.month);
    if (calMonth < 0) (calMonth = 11), calYear--;
    if (calMonth > 11) (calMonth = 0), calYear++;
    renderCalendar();
  });

  // ---------- swipe / arrow-key day navigation ----------

  const ENTER_KEY = "fitapp.dayEnter";
  function go(direction) {
    // direction: "next" (content leaves to the left) or "prev" (leaves to the right)
    try {
      sessionStorage.setItem(ENTER_KEY, direction);
    } catch {
      /* animation hint only */
    }
    day.classList.add(direction === "next" ? "leave-left" : "leave-right");
    setTimeout(() => (location.href = direction === "next" ? day.dataset.next : day.dataset.prev), 140);
  }

  try {
    const enter = sessionStorage.getItem(ENTER_KEY);
    sessionStorage.removeItem(ENTER_KEY);
    if (enter) day.classList.add(enter === "next" ? "enter-from-right" : "enter-from-left");
  } catch {
    /* ignore */
  }

  let touch = null;
  day.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || e.target.closest("input")) return (touch = null);
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  day.addEventListener("touchmove", (e) => {
    if (!touch || drag) return;
    const dx = e.touches[0].clientX - touch.x;
    const dy = e.touches[0].clientY - touch.y;
    if (Math.abs(dx) > Math.abs(dy)) day.style.transform = `translateX(${dx * 0.4}px)`;
  }, { passive: true });
  day.addEventListener("touchend", (e) => {
    day.style.transform = "";
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    const quick = Date.now() - touch.t < 800;
    touch = null;
    if (quick && Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) go(dx < 0 ? "next" : "prev");
  });
  day.addEventListener("touchcancel", () => {
    day.style.transform = "";
    touch = null;
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea") || document.querySelector("dialog[open]")) return;
    if (e.key === "ArrowLeft") go("prev");
    if (e.key === "ArrowRight") go("next");
  });
})();
