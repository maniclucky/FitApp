// Parity with the Flask app's helpers, using outputs recorded by test/parity/oracle_text.py.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as T from "../src/logic/text";

const FILE = new URL("./fixtures/oracle-text.json", import.meta.url);
const oracle = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : null;

type Attempt = { ok?: unknown; error?: string };
// Python errors without a message are recorded by type name (e.g. "ValueError"); those only need to throw.
function expectSame(fn: () => unknown, expected: Attempt, what: string) {
  if ("error" in expected) {
    let message: string | null = null;
    try {
      fn();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message, `${what} should fail`).not.toBeNull();
    if (!/^[A-Z]\w+Error$/.test(expected.error!)) expect(message, what).toBe(expected.error);
  } else {
    expect(fn(), what).toEqual(expected.ok);
  }
}

describe.skipIf(!oracle)("text helpers match Flask", () => {
  const cases = (key: string) => oracle[key] as any[];
  it("formatG", () => cases("formatG").forEach(([v, out]) => expect(T.formatG(v), String(v)).toBe(out)));
  it("round2", () => cases("round2").forEach(([v, out]) => expect(T.round2(v), String(v)).toBe(out)));
  it("formatNumber", () => cases("formatNumber").forEach(([v, out]) => expect(T.formatNumber(v)).toBe(out)));
  it("formatDuration", () => cases("formatDuration").forEach(([v, out]) => expect(T.formatDuration(v)).toBe(out)));
  it("truncate1", () => cases("truncate1").forEach(([v, out]) => expect(T.truncate1(v), String(v)).toBe(out)));
  it("formatVolume", () => cases("formatVolume").forEach(([v, out]) => expect(T.formatVolume(v), String(v)).toBe(out)));
  it("cleanName", () => cases("cleanName").forEach(([v, out]) => expect(T.cleanName(v, 100), JSON.stringify(v)).toBe(out)));
  it("cleanMuscles", () => cases("cleanMuscles").forEach(([v, out]) => expect(T.cleanMuscles(v)).toEqual(out)));
  it("cleanNote", () => cases("cleanNote").forEach(([v, r]) => expectSame(() => T.cleanNote(v, "The note"), r, JSON.stringify(v))));
  it("parseLogValue", () =>
    cases("parseLogValue").forEach(([v, weight, reps]) => {
      expectSame(() => T.parseLogValue(v, "Weight", { integer: false, maximum: 10_000 }), weight, `weight ${JSON.stringify(v)}`);
      expectSame(() => T.parseLogValue(v, "Reps", { integer: true, maximum: 9_999 }), reps, `reps ${JSON.stringify(v)}`);
    }));
  // Callers replace parseReps errors with their own message, so only "fails or not" matters.
  it("parseReps", () =>
    cases("parseReps").forEach(([v, r]) =>
      expectSame(() => T.parseReps(v), "error" in r ? { error: "ValueError" } : r, JSON.stringify(v))));
  it("parseDuration", () =>
    cases("parseDuration").forEach(([v, r]) => expectSame(() => T.parseDuration(v, "Plank, set 1"), r, JSON.stringify(v))));
  it("repTargetLabel", () => cases("repTargetLabel").forEach(([a, out]) => expect(T.repTargetLabel(a[0], a[1], a[2])).toBe(out)));
  it("setTargetLabel", () =>
    cases("setTargetLabel").forEach(([a, out]) => expect(T.setTargetLabel(a[0], a[1], a[2], a[3], a[4], a[5])).toBe(out)));
  it("historyDate", () => cases("historyDate").forEach(([d, out]) => expect(T.historyDate(d, oracle.today), d).toBe(out)));
  it("dayTitle", () => cases("dayTitle").forEach(([d, out]) => expect(T.dayTitle(d, "2026-09-30"), d).toEqual(out)));
  it("monthBefore", () => cases("monthBefore").forEach(([d, out]) => expect(T.monthBefore(d), d).toBe(out)));
  it("muscle title-casing", () =>
    cases("muscleTitle").forEach(([n, out]) => expect(T.isLower(n) ? T.titleCase(n) : n, n).toBe(out)));
});

describe("dates", () => {
  it("parses ISO dates strictly", () => {
    expect(T.parseIsoDate("2026-02-29")).toBeNull();
    expect(T.parseIsoDate("2026-9-30")).toBeNull();
    expect(T.parseIsoDate("2024-02-29")?.toISOString().slice(0, 10)).toBe("2024-02-29");
    expect(T.addDays("2026-03-28", 3)).toBe("2026-03-31");
    expect(T.daysBetween("2026-09-01", "2026-09-30")).toBe(29);
  });
});
