// Parsing and formatting shared by every part of the app. Ported from the Flask app
// (app.py / models.py); where Python's behaviour is subtle (number formatting, rounding,
// title-casing) it's reproduced exactly, so data and labels match what Flask produced.

export const NOTE_MAX_LENGTH = 500;
export const TRACKING_MODES = ["weight", "reps", "time", "distance"] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];
export const MUSCLE_ROLES = ["primary", "ancillary"] as const;
export type MuscleRole = (typeof MUSCLE_ROLES)[number];
/** How much one set counts toward a muscle's volume, by the muscle's role in the exercise. */
export const MUSCLE_SET_WEIGHTS: Record<MuscleRole, number> = { primary: 1, ancillary: 0.5 };

/** Python truthiness (JSON values): false for null, false, 0, "", [] and {}. */
export function pyTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object" && v !== null) return Object.keys(v).length > 0;
  return Boolean(v);
}

/** A user-facing validation problem; its message is shown as-is. */
export class ValidationError extends Error {}

// ---------- Python-compatible number formatting ----------

/** Python's f"{v:g}": 6 significant digits, trailing zeros dropped, exponent outside 1e-4..1e6. */
export function formatG(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  const [mantissa, exp] = v.toExponential(5).split("e");
  const x = Number(exp);
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (x < -4 || x >= 6) return `${strip(mantissa)}e${x < 0 ? "-" : "+"}${String(Math.abs(x)).padStart(2, "0")}`;
  return strip(v.toFixed(5 - x));
}

/**
 * Python's round(x, 2): nearest hundredth of the exact binary value, exact halves to even.
 * 2.675 is really 2.67499999… so it goes down; 0.125 is exact, so it goes to 0.12.
 */
export function round2(x: number): number {
  // toFixed uses the exact binary value; 20 places shows whether x is a true .xx5 tie.
  if (/^-?\d+\.\d\d50+$/.test(x.toFixed(20))) {
    const hundredths = Math.trunc(Math.abs(x) * 100); // exact for a true tie
    const even = hundredths % 2 === 0 ? hundredths : hundredths + 1;
    return (Math.sign(x) * even) / 100;
  }
  return Number(x.toFixed(2));
}

/** The `num` filter: 135.0 -> "135", 2.25 -> "2.25", null -> "". Floats format like Python's :g. */
export function formatNumber(value: number | null | undefined): string {
  if (value == null) return "";
  return formatG(value);
}

/** 90 -> "1:30", null -> "". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Cut off (not round) to one decimal: 8.1666 -> "8.1", 8.0 -> "8". */
export function truncate1(value: number): string {
  return formatG(Math.floor(value * 10 + 1e-9) / 10);
}

/** Thousands-separated, cut off at one decimal: 12345.67 -> "12,345.6", 1200 -> "1,200". */
export function formatVolume(value: number): string {
  const cut = Math.floor(value * 10 + 1e-9) / 10;
  const [int, frac] = cut.toFixed(1).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === "0" ? grouped : `${grouped}.${frac}`;
}

/** Python's f"{n:,}" for an integer: 10000 -> "10,000". */
export function withCommas(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---------- Names and notes ----------

const pySplit = (s: string) => s.split(/[\s\u001c-\u001f\u0085]+/u).filter(Boolean);

/** Collapse whitespace, drop leading '#'s, and truncate to maxLen characters. */
export function cleanName(value: string, maxLen: number): string {
  const collapsed = pySplit(value.replace(/^#+/, "")).join(" ");
  return Array.from(collapsed).slice(0, maxLen).join("");
}

/** Normalize muscle names; drop blanks and case-insensitive duplicates. */
export function cleanMuscles(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    const name = cleanName(v, 50);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      result.push(name);
    }
  }
  return result;
}

/** Python's str.islower(): has a cased character and every cased character is lowercase. */
export function isLower(s: string): boolean {
  return s === s.toLowerCase() && s !== s.toUpperCase();
}

/** Python's str.title() for an all-lowercase string: capitalize each letter that follows a non-letter. */
export function titleCase(s: string): string {
  return s.replace(/(^|[^\p{L}])(\p{L})/gu, (_m, before: string, letter: string) => before + letter.toUpperCase());
}

/** Trimmed note with Unix newlines, or null if blank. Throws ValidationError if too long or not text. */
export function cleanNote(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
  const text = value.replace(/\r\n/g, "\n").trim();
  if (Array.from(text).length > NOTE_MAX_LENGTH) {
    throw new ValidationError(`${label} can be at most ${NOTE_MAX_LENGTH} characters.`);
  }
  return text || null;
}

// ---------- Parsing numbers from forms ----------

/** Python's float() on a string: optional whitespace, sign, digits/decimal/exponent, inf/nan. */
function pyFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") throw new TypeError();
  const s = value.trim().replace(/(?<=\d)_(?=\d)/g, ""); // Python allows 1_000
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  throw new TypeError();
}

/** Blank -> null; otherwise a finite number in [0, maximum]. Throws ValidationError with a user message. */
export function parseLogValue(
  value: unknown,
  label: string,
  { integer, maximum }: { integer: boolean; maximum: number },
): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") throw new ValidationError(`${label} must be a number.`);
  let number: number;
  try {
    number = pyFloat(value);
  } catch {
    throw new ValidationError(`${label} must be a number.`);
  }
  if (!Number.isFinite(number) || !(number >= 0 && number <= maximum)) {
    throw new ValidationError(`${label} must be between 0 and ${withCommas(maximum)}.`);
  }
  if (integer) {
    if (number !== Math.trunc(number)) throw new ValidationError(`${label} must be a whole number.`);
    return Math.trunc(number);
  }
  return round2(number);
}

/** Python's int() on a value: ints, integral floats truncate, digit strings (with sign/space). */
function pyInt(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError();
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\s*[+-]?\d+(_\d+)*\s*$/.test(value)) return Number(value.replace(/_/g, ""));
  throw new TypeError();
}

/** Reps target: an int in 1..999, null for blank; throws (any error) otherwise. */
export function parseReps(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") throw new TypeError();
  const n = pyInt(value);
  if (!(n >= 1 && n <= 999)) throw new RangeError();
  return n;
}

/** Seconds from an int, "m:ss", or microwave digits ("130" -> 90); blank -> null. Mirrors FitTime.parse. */
export function parseDuration(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  let seconds: number;
  if (typeof value === "number" && Number.isInteger(value)) {
    seconds = value;
  } else if (typeof value === "string" && /^\d*:\d{1,2}$/.test(value.trim())) {
    const [minutes, secs] = value.trim().split(":");
    seconds = Number(minutes || 0) * 60 + Number(secs);
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const padded = value.trim().padStart(3, "0");
    seconds = Number(padded.slice(0, -2)) * 60 + Number(padded.slice(-2));
  } else {
    throw new ValidationError(`${label}: time should look like 1:30.`);
  }
  if (!(seconds >= 0 && seconds <= 86_400)) throw new ValidationError(`${label}: time must be at most 24 hours.`);
  return seconds;
}

// ---------- Labels ----------

/** e.g. "8–12", "10", "8+", "≤12", "AMRAP", or "" for no target. */
export function repTargetLabel(lo: number | null, hi: number | null, amrap: boolean | number): string {
  if (amrap) return "AMRAP";
  if (lo && hi) return lo === hi ? String(lo) : `${lo}–${hi}`;
  if (lo) return `${lo}+`;
  if (hi) return `≤${hi}`;
  return "";
}

/** A planned set in brief, e.g. "8–12 @ 135 lb", "50 lb · 0:45", "25:00 · 3 mi", or "". */
export function setTargetLabel(
  repsMin: number | null, repsMax: number | null, amrap: boolean | number,
  weight: number | null, seconds: number | null, distance: number | null,
): string {
  let head = repTargetLabel(repsMin, repsMax, amrap);
  if (weight != null) head = head ? `${head} @ ${formatG(weight)} lb` : `${formatG(weight)} lb`;
  const parts = [head, formatDuration(seconds), distance != null ? `${formatG(distance)} mi` : ""];
  return parts.filter(Boolean).join(" · ");
}

// ---------- Dates (YYYY-MM-DD strings, local calendar days) ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Parses "YYYY-MM-DD" strictly (like Python's date.fromisoformat); null if invalid. */
export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1 || date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

// Calendar dates are handled as UTC-midnight Date objects so arithmetic never hits DST.
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => {
  const d = parseIsoDate(iso)!;
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
};
export const daysBetween = (a: string, b: string) => Math.round((parseIsoDate(b)!.getTime() - parseIsoDate(a)!.getTime()) / 86_400_000);
/** Today's local calendar date as YYYY-MM-DD (the phone's date, like Flask used the server's). */
export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** "Tue, Sep 29", with the year added when it isn't `today`'s year. */
export function historyDate(iso: string, today: string): string {
  const d = parseIsoDate(iso)!;
  const label = `${WEEKDAYS[d.getUTCDay()].slice(0, 3)}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return iso.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${d.getUTCFullYear()}`;
}

/** [title, subtitle]: "Today" / "Wednesday, Sep 29", or "Jan 5" / "Wednesday, 2000". */
export function dayTitle(iso: string, today: string): [string, string] {
  const d = parseIsoDate(iso)!;
  const weekday = WEEKDAYS[d.getUTCDay()];
  const relative = ({ 0: "Today", [-1]: "Yesterday", 1: "Tomorrow" } as Record<number, string>)[daysBetween(today, iso)];
  if (relative) return [relative, `${weekday}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`];
  return [`${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`, `${weekday}, ${d.getUTCFullYear()}`];
}

/** The same day one calendar month earlier, clamped to that month's length (Mar 31 -> Feb 28). */
export function monthBefore(iso: string): string {
  const d = parseIsoDate(iso)!;
  const year = d.getUTCMonth() > 0 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const month = d.getUTCMonth() > 0 ? d.getUTCMonth() - 1 : 11; // 0-based
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return isoDate(new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay))));
}
