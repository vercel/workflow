---
'@workflow/world-postgres': patch
---

Fix race condition in `step_started` that could corrupt the event log. The `UPDATE` for `step_started` now includes a conditional guard (`status NOT IN ('completed', 'failed', 'cancelled')`) to prevent a concurrent step execution from reverting a completed step back to running. Also adds terminal-state guards to `step_retrying`, `run_completed`, `run_failed`, and `run_cancelled`, and adds `cancelled` to the existing guards on `step_completed` and `step_failed`.
