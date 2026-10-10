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
