import { describe, expect, it } from "vitest";
import { dayToWorkoutItems, type LogEntry } from "../src/logic/day";

const entry = (exerciseId: number, group: number | null, sets: number) =>
  ({ exercise: { id: exerciseId }, superset_group: group, sets: Array.from({ length: sets }, () => ({ target_reps_min: 8, target_amrap: true, target_weight: 135 })) }) as unknown as LogEntry;

describe("build workout from day", () => {
  it("keeps order, supersets and set counts, and blanks every target", () => {
    const items = dayToWorkoutItems([entry(5, null, 2), entry(7, 1, 3), entry(9, 1, 3), entry(5, 2, 1), entry(4, null, 4)]);
    expect(items.map((it) => [it.exercise_id, it.superset_next, it.sets.length])).toEqual([
      [5, false, 2], [7, true, 3], [9, false, 3], [5, false, 1], [4, false, 4],
    ]);
    for (const it of items) {
      for (const set of it.sets) expect(set).toEqual({ min: null, max: null, amrap: false, weight: null, time: null, distance: null });
    }
  });
});
