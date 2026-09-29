# Data model
The database schema, and the reasons behind the parts that aren't obvious.

Last updated: 2026-09-29

## Tables (see `models.py`)
- **exercise**: `name` (unique, case-insensitive via SQLite `NOCASE` collation) plus four booleans: `tracks_weight`, `tracks_reps`, `tracks_time`, `tracks_distance`. An exercise can track any combination of these, and must track at least one (checked by the form).
- **muscle_group**: the canonical list of muscle names (unique, `NOCASE`). 18 defaults are seeded on first run, in head-to-toe order, and the UI shows them in `id` order. Users can add custom groups from the form. A custom name that is all lowercase gets title-cased; a leading `#` is stripped.
- **exercise_muscle**: links exercises to muscle groups, with `role` set to `primary` or `ancillary` (the user chose these names; use them everywhere: code, DB, and UI). The primary key is (exercise_id, muscle_group_id), so a muscle can't be both roles for the same exercise. The form enforces the same rule: the JS disables the twin chip, and the server drops any ancillary that's also primary.

## Decisions
- **Chips, not free-text hashtags, for muscles**: the user first suggested hashtags. We chose preset tappable chips with an "Add" box for custom names instead, because free-typed tags drift (#quad / #quads / #quadriceps), and that would break later filtering and volume totals by muscle.
- **Tracking modes as boolean columns**: the set is small and fixed. If modes ever need to be user-defined, move them to a join table.
- **No migrations yet**: the app calls `db.create_all()` at startup, which creates missing tables but does NOT change existing ones. Any schema change means either adding Flask-Migrate (preferred once real data matters) or deleting `instance/fitapp.db` during early development. Ask the user before deleting it.
- **No CSRF protection yet**: acceptable while the app is localhost-only. Add Flask-WTF/CSRF before exposing it anywhere.

## Exercise edit/delete rules
- `/exercises/<id>/edit` reuses the exercise form (`exercise_form` view). Saving replaces the exercise's muscle links (clear, flush, re-add).
- If an edit turns **reps tracking off**, rep targets (min/max/AMRAP) on that exercise's workout sets are cleared, so workouts don't keep stale targets.
- **Deleting is blocked while any workout uses the exercise.** The panel shows which workouts use it and offers no Delete button, and the server refuses it too (flash error). This was chosen over silently removing the exercise from those workouts.

## Workouts (templates built in the workout builder)
- **workout**: `name` is unique and case-insensitive (`NOCASE`). A workout is a plan; logging actual performance will need separate tables later.
- **workout_exercise**: one exercise slot in a workout, ordered by `position`. The same exercise can appear more than once. `superset_group` is a nullable int; consecutive slots that share a value form a superset. Groups are always contiguous (the save code guarantees this) and chains of 3+ are allowed. `Workout.blocks` groups slots for display.
- **workout_set**: one planned set, ordered by `position`, with `reps_min` and `reps_max` (each optional) and `is_amrap`. CHECK constraints: AMRAP means both bounds are NULL, min ≤ max, and min ≥ 1. Exercises that don't track reps keep only the set count; their reps and AMRAP values are ignored and stored as NULL/false.
- The builder UI has no targets for weight, time or distance yet; only the rep range is planned. Those modes will be logged when the workout is performed.

## Workout builder behavior (`static/workout_builder.js`)
- The page keeps the workout in a JS array and posts it as JSON in the hidden `items` field. The server (`parse_workout_items` in `app.py`) validates everything again. On an error it re-renders the page with the normalized items, so nothing the user entered is lost.
- In the UI, a superset is a `superset_next` toggle between adjacent cards. Rules:
  - Moving an exercise unlinks it from its neighbours.
  - Removing a linked exercise only keeps the chain if the removed one was linked on both sides.
  - The last item's link is always cleared.
- "+ Add set" copies the previous set's values. A new exercise starts with 3 blank sets.
- **Autofill (user requirement):** the first value typed into an exercise's min (or max) column is copied live into that column on the exercise's other non-AMRAP sets. When that field loses focus with a value, the column is marked `filled` and later edits no longer spread to other sets. Min and max are tracked separately for each exercise. When a workout is loaded (edit, or re-render after an error), any column that already has values counts as filled. `filled` exists only in the browser; the server ignores it.
- **Editing:** `/workouts/<id>/edit` uses the same builder (`workout_builder` view, in create or edit mode). Tapping a card on the Workouts list opens it. Saving replaces all of the workout's slots and sets: it clears them, flushes, then inserts, to avoid the (workout_id, position) unique key. **Once workout logging exists, this delete-and-recreate will orphan logged history.** Before then, switch to updating rows in place, or make logs reference something stable.
- **Deleting:** `POST /workouts/<id>/delete`, reached from the × on each Workouts list card or the red button on the edit screen. Both open the shared confirmation panel. It cascade-deletes the workout's slots and sets. Like editing, this must be revisited once logging exists (probably archive the workout rather than hard-delete it when history exists).

## Demo data
- Created by `scripts/demo_data.py`: 18 exercises and 5 workouts, all named with the `[DEMO] ` prefix. The set covers every tracking mode, supersets (including a tri-set), AMRAP, and every kind of rep range.
- Demo workouts only use demo exercises. `--remove` deletes demo workouts first, then demo exercises, but keeps (and reports) any demo exercise that a non-demo workout uses.
- The script reuses `build_workout_exercises` and `get_or_create_muscle` from `app.py`, so it always follows the same rules as the UI.
