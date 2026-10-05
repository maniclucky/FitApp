import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/schema";
import { setSupersetWithNext } from "../src/logic/day";
import { openTestDb } from "./sqljs";

// Six exercises on one day; `groups` gives each one's starting superset_group.
async function dayWith(groups: (number | null)[]) {
  const db = await openTestDb();
  await migrate(db);
  await db.run("INSERT INTO exercise (id, name, tracks_reps, created_at) VALUES (1, 'X', 1, 'x')");
  for (const [k, g] of groups.entries()) {
    await db.run("INSERT INTO log_exercise (id, date, position, exercise_id, superset_group) VALUES (?, '2026-10-01', ?, 1, ?)", [k + 1, k + 1, g]);
  }
  const state = async () => {
    const rows = await db.all("SELECT superset_group AS g FROM log_exercise ORDER BY position");
    // Compare shapes, not numbers: which neighbours share a group.
    return rows.map((r, k) => (r.g !== null && rows[k + 1]?.g === r.g ? "+" : r.g === null ? "." : "|")).join("");
  };
  return { db, state };
}

describe("day superset button", () => {
  it("links two plain exercises, extends and merges supersets, and unlinks by splitting", async () => {
    const { db, state } = await dayWith([null, null, null, 5, 5, null]);
    expect(await state()).toBe("...+|.");
    await setSupersetWithNext(db, 1, true);
    expect(await state()).toBe("+|.+|.");
    await setSupersetWithNext(db, 2, true); // extend 1–2 with 3
    expect(await state()).toBe("++|+|.");
    await setSupersetWithNext(db, 3, true); // merge 1–3 with 4–5
    expect(await state()).toBe("++++|.");
    await setSupersetWithNext(db, 2, false); // split after 2
    expect(await state()).toBe("+|++|.");
    await setSupersetWithNext(db, 1, false); // a lone exercise isn't a superset
    expect(await state()).toBe("..++|.");
    await setSupersetWithNext(db, 4, false); // 3–4 | 5: 5 ends up alone
    expect(await state()).toBe("..+|..");
    await setSupersetWithNext(db, 3, true); // already linked: no change
    expect(await state()).toBe("..+|..");
  });

  it("refuses the last exercise of the day", async () => {
    const { db } = await dayWith([null, null]);
    await expect(setSupersetWithNext(db, 2, true)).rejects.toThrow(/no exercise below/);
  });
});
