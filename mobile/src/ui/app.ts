// The app shell: hash routing (#/day/2026-09-30, #/workouts, ...), rendering a view into the
// page with the bottom bar and flash messages, and the shared delete confirmation.
//
// Each navigation (or refresh) renders the view from scratch and then calls its mount()
// with an AbortSignal; listeners added with { signal } are removed before the next render.
import { html, nothing, render, type TemplateResult } from "lit-html";
import type { Db } from "../db/types";
import { todayIso } from "../logic/text";

export interface Ctx {
  db: Db;
  params: string[];
  query: URLSearchParams;
  today: string;
  /** Registers what the shared delete confirmation does for data-confirm-delete="<key>". */
  onDelete(key: string, action: () => Promise<void>): void;
}

export interface View {
  title: string;
  /** Which bottom-bar item is current; omit it (and set tabbar: false) for forms. */
  section?: "day" | "routines" | "workouts" | "exercises" | "progress" | "settings";
  tabbar?: boolean;
  /** Extra class on <main>, e.g. "has-timer". */
  screenClass?: string;
  content: TemplateResult;
  mount?(root: HTMLElement, signal: AbortSignal, ctx: Ctx): void;
}

type Handler = (ctx: Ctx) => Promise<View>;
const routes: [RegExp, Handler][] = [];
export function route(pattern: RegExp, handler: Handler) {
  routes.push([pattern, handler]);
}

// ---------- navigation ----------

export function href(path: string, query?: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams(Object.entries(query ?? {}).filter((e): e is [string, string] => e[1] != null && e[1] !== ""));
  return `#${path}${q.size ? `?${q}` : ""}`;
}
export const currentPath = () => location.hash.slice(1) || "/day";
export function navigate(to: string) {
  if (location.hash === to) void show(false);
  else location.hash = to;
}
/** Re-render the current screen (e.g. after a change), keeping the scroll position. */
export const refresh = () => show(true);
export const back = () => history.back();

// Each history entry remembers the route it was opened from (history.state.from), so leaving a
// form with returnTo() steps back to that screen instead of stacking a second copy of it, and the
// phone's back button then goes where it should (e.g. exercise page → list, not → edit form).
let lastHash = "";
let replacedFrom: string | null = null;

/** Go to `target`: back through history if this screen was opened from it, else replace this screen. */
export function returnTo(target: string) {
  const from = (history.state as { from?: string } | null)?.from;
  if (from === target) history.back();
  else if (location.hash === target) void show(false);
  else {
    replacedFrom = from ?? "";
    location.replace(target);
  }
}

// ---------- form state across a re-render ----------
// A rejected form save stashes its errors and cleaned-up values, then refreshes; the view
// takes them back out when it renders. Keyed by path, so they never leak to another screen.
const stashes = new Map<string, unknown>();
export function stash(value: unknown) {
  stashes.set(currentPath(), value);
}
export function takeStash<T>(): T | undefined {
  const value = stashes.get(currentPath()) as T | undefined;
  stashes.delete(currentPath());
  return value;
}

// ---------- flash messages ----------

let flashes: { message: string; error: boolean }[] = [];
export function flash(message: string, error = false) {
  flashes.push({ message, error });
}

// ---------- rendering ----------

let db: Db;
let controller: AbortController | null = null;
let deleteActions = new Map<string, () => Promise<void>>();
const root = () => document.getElementById("app")!;

async function show(keepScroll: boolean) {
  if ((history.state as { from?: string } | null)?.from === undefined) {
    history.replaceState({ from: replacedFrom ?? lastHash }, "");
  }
  replacedFrom = null;
  lastHash = location.hash;
  const [path, queryString] = currentPath().split("?");
  const scroll = keepScroll ? scrollY : 0;
  controller?.abort();
  controller = new AbortController();
  deleteActions = new Map();
  const ctx: Ctx = {
    db, params: [], query: new URLSearchParams(queryString ?? ""), today: todayIso(),
    onDelete: (key, action) => deleteActions.set(key, action),
  };
  let view: View;
  const match = routes.find(([re]) => re.test(path));
  try {
    if (!match) throw new Error("Page not found.");
    ctx.params = path.match(match[0])!.slice(1).map(decodeURIComponent);
    view = await match[1](ctx);
  } catch (e) {
    console.error(e);
    view = { title: "FitApp", section: "day", content: html`<p class="empty">${(e as Error).message}</p><p class="empty"><a href="#/day">Go to today</a></p>` };
  }
  document.title = view.title === "FitApp" ? "FitApp" : `${view.title} · FitApp`;
  const messages = flashes;
  flashes = [];
  render(nothing, root()); // fresh DOM each time, so view scripts never double-bind
  render(shell(view, messages), root());
  window.scrollTo(0, scroll);
  view.mount?.(root(), controller.signal, ctx);
  wireNav(controller.signal);
}

const gearIcon = html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

function shell(view: View, messages: typeof flashes) {
  const tabbar = view.tabbar ?? true;
  const tracking = [["day", "Today"], ["progress", "Progress"]] as const;
  const library = [["routines", "Routines"], ["workouts", "Workouts"], ["exercises", "Exercises"]] as const;
  const current = (s: string) => (view.section === s ? "page" : nothing);
  // A pop-up menu button (user requirement: the label stays fixed and turns accent-colored on any of its screens).
  const menu = (id: string, label: string, items: readonly (readonly [string, string])[]) => html`
    <div class="tab-menu">
      <button type="button" class="tab-menu-btn" aria-expanded="false" aria-controls="${id}-menu"
              ?data-current=${items.some(([k]) => k === view.section)}>${label} <span aria-hidden="true">&#9652;</span></button>
      <div class="tab-menu-list" id="${id}-menu" hidden>
        ${items.map(([k, text]) => html`<a href="#/${k}" aria-current=${current(k)}>${text}</a>`)}
      </div>
    </div>`;
  return html`
    <main class="screen${tabbar ? " has-tabbar" : ""}${view.screenClass ? ` ${view.screenClass}` : ""}">
      ${messages.map((m) => html`<div class="flash${m.error ? " error" : ""}" role=${m.error ? "alert" : "status"}>${m.message}</div>`)}
      ${view.content}
    </main>
    ${tabbar ? html`
      <nav class="tabbar" aria-label="Main">
        ${menu("tracking", "Tracking", tracking)}
        ${menu("library", "Library", library)}
        <a href="#/settings" class="tab-icon" aria-label="Settings" aria-current=${current("settings")}>${gearIcon}</a>
      </nav>` : nothing}
    <dialog class="sheet" id="confirm-delete" aria-labelledby="confirm-delete-title">
      <h2 id="confirm-delete-title">Delete?</h2>
      <p class="hint" id="confirm-delete-detail"></p>
      <form method="dialog" class="sheet-actions" id="confirm-delete-form">
        <button type="button" class="button subtle block" data-cancel>Cancel</button>
        <button type="submit" class="button danger-solid block" data-submit>Delete</button>
      </form>
    </dialog>`;
}

/** The bottom bar's pop-up menus (Tracking, Library), and the shared delete confirmation (see data-confirm-delete). */
function wireNav(signal: AbortSignal) {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab-menu-btn")) {
    const menu = document.getElementById(btn.getAttribute("aria-controls")!)!;
    const setOpen = (open: boolean) => {
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    };
    btn.addEventListener("click", () => {
      setOpen(menu.hidden === true);
      if (!menu.hidden) menu.querySelector("a")!.focus();
    }, { signal });
    // Clicking anywhere outside this menu (including the other menu's button) closes it.
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !menu.parentElement!.contains(e.target as Node)) setOpen(false);
    }, { signal });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) {
        setOpen(false);
        btn.focus();
      }
    }, { signal });
  }

  // Any button with data-confirm-delete="<key>" data-name="<item>" (or data-title="<question>"),
  // optional data-detail, data-blocked and data-confirm-label (the button text, default "Delete"),
  // opens the confirmation; confirming runs the view's action.
  const dialog = document.getElementById("confirm-delete") as HTMLDialogElement;
  const title = document.getElementById("confirm-delete-title")!;
  const detail = document.getElementById("confirm-delete-detail")!;
  const form = document.getElementById("confirm-delete-form") as HTMLFormElement;
  const cancel = dialog.querySelector("[data-cancel]") as HTMLButtonElement;
  const submit = dialog.querySelector("[data-submit]") as HTMLButtonElement;
  let pending: string | null = null;
  document.addEventListener("click", (e) => {
    const trigger = (e.target as Element).closest<HTMLElement>("[data-confirm-delete]");
    if (!trigger) return;
    e.preventDefault();
    const { blocked, name, detail: text } = trigger.dataset;
    title.textContent = blocked ? `Can’t delete “${name}”` : trigger.dataset.title || `Delete “${name}”?`;
    detail.textContent = blocked || text || "This can’t be undone.";
    submit.hidden = Boolean(blocked);
    submit.textContent = trigger.dataset.confirmLabel || "Delete";
    cancel.textContent = blocked ? "OK" : "Cancel";
    pending = trigger.dataset.confirmDelete!;
    dialog.showModal();
  }, { signal });
  cancel.addEventListener("click", () => dialog.close(), { signal });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // tap on backdrop
  }, { signal });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const action = pending && deleteActions.get(pending);
    dialog.close();
    if (!action) return;
    try {
      await action();
    } catch (err) {
      flash((err as Error).message, true);
      await refresh();
    }
  }, { signal });
}

export function start(database: Db) {
  db = database;
  window.addEventListener("hashchange", () => void show(false));
  // A screen's ← arrow returns to its parent screen (see returnTo).
  document.addEventListener("click", (e) => {
    const link = (e.target as Element).closest<HTMLAnchorElement>("a.back[href^='#/']");
    if (!link || e.defaultPrevented) return;
    e.preventDefault();
    returnTo(link.getAttribute("href")!);
  });
  if (!location.hash) history.replaceState(null, "", "#/day");
  void show(false);
}
