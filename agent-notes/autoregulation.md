# Autoregulation
How autoregulation sets rep and weight targets from the previous session, and how deload days fit in. Mobile app only (`mobile/src/logic/autoregulation.ts`), not in Flask.

Last updated: 2026-10-10

## Rules (user requirement, 2026-10-04)
- **One switch in Settings (user requirement, 2026-10-10):** **Autoregulation** on the Settings screen, per device (`fitapp.autoregulate` in localStorage via `ui/prefs.ts`, off by default). The day view passes it to `loadRoutine` / `loadWorkout` / `addExercises` as an `autoregulate` argument (default false, so the logic stays Flask-parity when off). It replaced the per-routine checkbox: `routine.autoregulate` is still stored, imported and exported, and kept through edits by a hidden field in the routine editor, but nothing reads it.
- What it does depends on how things are added to a day:
  - **Routine** (including the ↻ override) and **workout** (Workouts tab): the workout's own latest non-deload session, whatever its source (see below). Same rule for both.
  - **Exercises** added on their own: each exercise's own last session, the same as the AR button (below).
- For each set, using the same set position last time: actual reps `r`, weight `w` (actual, else that set's target weight, else the plan's), previous rep target `t` (`log_set.target_reps`, else the range minimum). The range is the plan's, and a blank end defaults to **8–15** (`repRange`).
  1. `r < min` → weight `w − 5` (never below 0), reps `min`.
  2. Otherwise next = `r + 1` if `r ≥ t` (actual + 1, user-confirmed), else `r`.
  3. next `> max` → weight `w + 5`, reps `min`.
- A set not checked off, or checked with no reps, **copies the previous targets** (`target_reps`, `target_weight`). Typed-but-unchecked values don't count; the user reconfirmed this on 2026-10-04 after test days with only typed values produced blank targets.
- **AMRAP sets (user, 2026-10-04):** reps follow the same rule with no range (`r + 1` if `r ≥ t`, else `r`; first time `t = r`), and the weight is carried over as `w`, **never adjusted**: changing it is left to the user. No −5 lb when reps drop.
- Not adjusted (plan targets kept): exercises that don't track reps, and sets with no matching set last time (e.g. a set added to the plan).
- Bodyweight (no weight logged or targeted, or the exercise doesn't track weight): reps only, held at the range maximum instead of adding weight. The user didn't rule on this case explicitly.

## AR button on day cards (user requirement, 2026-10-10)
- Each day card for an exercise that tracks reps has an **AR** button in its header (History became a tap on the exercise name). It sets that entry's targets by the rules above (`autoregulateEntry` in `logic/day.ts`), from the **exercise's** latest non-deload entry before that day, from any source (ad hoc or a workout; the workout doesn't matter). Sets match by position.
- It sets **targets only** (`target_reps`, `target_weight`, shown as placeholders), never logged values; the user chose this over filling the fields.
- **Completed sets are skipped, and so is each target whose field already has a value** (user requirement): a typed weight keeps that set's weight target, but its reps target still updates.
- The range is the set's own target range, 8–15 when it has none (an ad-hoc exercise). Sets past the reference's count keep their targets. No earlier entry → nothing changes and a toast says so. Works on any day, whether or not the Settings switch is on, and **replaces** existing targets (e.g. ones a workout's autoregulation set) with the exercise-based ones (user requirement).

## Which session is the reference
- The latest **non-deload** date before the load date on which that workout was logged, from **any source** (`log_exercise.workout_id`).
- No such date → the first use; the plan is loaded unchanged, even if the exercises have history elsewhere.
- Exercises are matched to the plan's slots **by exercise, in order** (the first copy of an exercise matches the first copy), so rearranging the workout still lines up. Duplicate exercises in one workout are rare (user).
- A slot whose exercise wasn't in that session (a **replaced** exercise) falls back to that exercise's latest earlier non-deload entry from any source (user requirement). No history → plan targets.

## Storage (schema v3)
- `routine.autoregulate` (bool, default 0; no longer read since 2026-10-10), `log_set.target_reps` (the single rep target; NULL when not autoregulated), and `deload_day (date PK)`.
- The reps placeholder shows `target_reps` when set (`target_label`), and the card's Reps label shows each distinct range of its autoregulated sets beneath it, in set order (e.g. `8–12 · AMRAP`). "+ Set" copies `target_reps` like the other targets.

## Deload days (user requirement)
- The **Deload day** toggle under the day header writes/removes a `deload_day` row (`setDeload`). Autoregulation skips those dates as references and uses the previous non-deload session instead. It doesn't change the routine's rotation (`routineNextIndex`) or anything else. **Clear day also removes the deload mark** (user, 2026-10-04).
