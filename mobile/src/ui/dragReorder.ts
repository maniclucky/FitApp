// Long-press to reorder a list (day view exercises, routine editor workouts, workout builder). Press and hold an
// item (not on an input, button or link) to lift it; the other items slide out of the way and
// the page auto-scrolls near the screen edges. Dropping calls onDrop(from, to) once the
// transforms are cleared, and the caller moves the DOM or its data.
//
// Classes: the list gets `reorder-list` (slide transitions), `reordering` while an item is
// lifted and `no-anim` while resetting; the lifted item gets `dragging` (and `settling` as it
// glides into place). Only verified with a mouse; a real touchscreen is still untested.

const LONG_PRESS_MS = 400;
const MOVE_TOLERANCE = 8; // px of finger drift allowed while waiting for the long press
const EDGE = 80; // px from the top/bottom of the viewport that auto-scrolls
const SETTLE_MS = 160;

export interface ReorderOptions {
  signal: AbortSignal;
  /** The draggable items, in order (direct children of the list). */
  items: () => HTMLElement[];
  /** Runs when an item is lifted, before anything is measured (e.g. collapse the cards). */
  onLift?: (item: HTMLElement) => void;
  /** Runs after the drop with the transforms cleared; from === to when nothing moved. */
  onDrop: (from: number, to: number, item: HTMLElement) => void;
  /** Extra space at the bottom of the screen not to drag under (e.g. a fixed timer bar). */
  bottomInset?: number;
}

type Drag = {
  item: HTMLElement; items: HTMLElement[]; tops: number[]; heights: number[]; gap: number;
  index: number; target: number; pageY0: number; clientY: number; raf: number;
};

export function longPressReorder(list: HTMLElement, o: ReorderOptions) {
  const { signal } = o;
  const on = (el: EventTarget, type: string, fn: (e: any) => void, extra: AddEventListenerOptions = {}) =>
    el.addEventListener(type, fn, { signal, ...extra });
  list.classList.add("reorder-list");
  let press: { item: HTMLElement; x: number; y: number; timer: number } | null = null;
  let drag: Drag | null = null;

  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };

  function startDrag() {
    const { item, y } = press!;
    press = null;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const topBefore = item.getBoundingClientRect().top;
    list.classList.add("reordering");
    o.onLift?.(item);
    // Keep the lifted item's top where it was on screen if lifting changed the layout.
    scrollBy(0, item.getBoundingClientRect().top - topBefore);
    const items = o.items();
    const tops = items.map((b) => b.getBoundingClientRect().top + scrollY);
    const heights = items.map((b) => b.offsetHeight);
    const gap = items.length > 1 ? tops[1] - tops[0] - heights[0] : 0;
    const index = items.indexOf(item);
    // The item's centre follows the finger.
    drag = { item, items, tops, heights, gap, index, target: index, pageY0: tops[index] + heights[index] / 2, clientY: y, raf: 0 };
    item.classList.add("dragging");
    moveDrag();
    navigator.vibrate?.(12);
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function moveDrag() {
    const d = drag!;
    const dy = d.clientY + scrollY - d.pageY0;
    d.item.style.transform = `translateY(${dy}px) scale(1.02)`;
    const center = d.tops[d.index] + d.heights[d.index] / 2 + dy;
    let target = d.index;
    for (let j = 0; j < d.items.length; j++) {
      const mid = d.tops[j] + d.heights[j] / 2;
      if (j > d.index && center > mid) target = j;
      if (j < d.index && center < mid && target >= d.index) target = j;
    }
    d.target = target;
    const shift = d.heights[d.index] + d.gap;
    d.items.forEach((b, j) => {
      if (j === d.index) return;
      const offset = j > d.index && j <= target ? -shift : j < d.index && j >= target ? shift : 0;
      b.style.transform = offset ? `translateY(${offset}px)` : "";
    });
  }

  function autoScroll() {
    if (!drag) return;
    const y = drag.clientY;
    const bottomEdge = innerHeight - EDGE - (o.bottomInset ?? 0);
    const speed = y < EDGE ? -(EDGE - y) / 5 : y > bottomEdge ? (y - bottomEdge) / 5 : 0;
    if (speed) {
      scrollBy(0, speed);
      moveDrag();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function endDrag() {
    const { item, items, tops, heights, index, target, raf } = drag!;
    cancelAnimationFrame(raf);
    drag = null;
    // Glide the lifted item into its slot, then hand over to onDrop with all transforms cleared.
    const finalTop = target > index ? tops[target] + heights[target] - heights[index] : tops[target];
    item.classList.add("settling");
    item.style.transform = `translateY(${finalTop - tops[index]}px)`;
    setTimeout(() => {
      list.classList.add("no-anim");
      item.classList.remove("dragging", "settling");
      for (const b of items) b.style.transform = "";
      o.onDrop(index, target, item);
      void list.offsetHeight; // apply the reset before re-enabling transitions
      list.classList.remove("no-anim", "reordering");
    }, SETTLE_MS);
  }

  on(list, "pointerdown", (e: PointerEvent) => {
    if (drag || !e.isPrimary || e.button !== 0 || (e.target as Element).closest("input, button, a, label")) return;
    const item = o.items().find((it) => it.contains(e.target as Node));
    if (!item) return;
    cancelPress();
    press = { item, x: e.clientX, y: e.clientY, timer: window.setTimeout(startDrag, LONG_PRESS_MS) };
  });
  on(document, "pointermove", (e: PointerEvent) => {
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
  on(document, "pointerup", release);
  on(document, "pointercancel", release);
  // While an item is lifted, the finger drags it instead of scrolling the page.
  on(document, "touchmove", (e: TouchEvent) => {
    if (drag && e.cancelable) e.preventDefault();
  }, { passive: false });
  // Long-pressing shouldn't pop the phone's context menu.
  on(list, "contextmenu", (e: Event) => {
    if (press || drag) e.preventDefault();
  });
  signal.addEventListener("abort", () => {
    cancelPress();
    if (drag) cancelAnimationFrame(drag.raf);
  });

  return { isDragging: () => drag !== null || press !== null };
}
