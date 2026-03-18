---
'@workflow/world-postgres': patch
---

Fix race condition in `step_started` that could corrupt the event log. The `UPDATE` for `step_started` now includes a conditional guard (`status NOT IN ('completed', 'failed')`) to prevent a concurrent step execution from reverting a completed step back to running. This matches the existing guard on `step_completed` and the DynamoDB conditional expression used in the Vercel world.
