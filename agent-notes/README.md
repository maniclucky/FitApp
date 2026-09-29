# Agent Notes

Shared, persistent reference information left by AI agents (and humans) working on FitApp.
Anything here is committed to git so future sessions can build on it.

## What belongs here
- Architecture decisions and the reasoning behind them
- Non-obvious gotchas, workarounds, and debugging findings
- External references (API docs, service quirks, dashboards)
- Conventions agreed on during development that aren't obvious from the code

## What does not belong here
- Secrets, credentials, or personal data
- Anything already obvious from the code or git history
- Temporary scratch work for a single session

## Conventions
- One topic per file, kebab-case names (e.g. `auth-flow.md`, `db-schema-decisions.md`).
- Start each file with a one-line summary, and add a `Last updated: YYYY-MM-DD` line.
- Update an existing note rather than creating a duplicate; delete notes that become wrong.
- Add every note to the index below with a one-line description.

## Index
- [stack-decisions.md](stack-decisions.md) — why Flask, mobile-first layout rules, localhost-only constraint
- [data-model.md](data-model.md) — exercise + workout tables, superset/AMRAP rules, builder behavior, no-migrations caveat
