// Per-device preferences kept in localStorage (like the rest timer's). Reads fall back to the
// default when storage is unavailable.
const QUICK_FILL = "fitapp.quickFill";

/** Quick fill: the first value typed in a column is copied to that column's other sets (day view and workout builder). On by default. */
export function quickFillOn(): boolean {
  try {
    return localStorage.getItem(QUICK_FILL) !== "off";
  } catch {
    return true;
  }
}
export function setQuickFill(on: boolean) {
  try {
    localStorage.setItem(QUICK_FILL, on ? "on" : "off");
  } catch {
    /* storage unavailable: the setting lasts until the app reloads */
  }
}

const AUTOREGULATE = "fitapp.autoregulate";

/**
 * Autoregulation (user requirement, 2026-10-10): sets rep and weight targets from the last session
 * when routines, workouts or exercises are added to a day. Off by default. Replaces the old
 * per-routine switch (routine.autoregulate is kept in the data but no longer read).
 */
export function autoregulateOn(): boolean {
  try {
    return localStorage.getItem(AUTOREGULATE) === "on";
  } catch {
    return false;
  }
}
export function setAutoregulate(on: boolean) {
  try {
    localStorage.setItem(AUTOREGULATE, on ? "on" : "off");
  } catch {
    /* storage unavailable: the setting lasts until the app reloads */
  }
}
