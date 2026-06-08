---
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Fix `world-local` and `world-postgres` turning duplicate processing of the same `hook_created` (same `runId`, `hookId`, and token) into a self-conflict; both worlds now throw `EntityConflictError` and are idempotent, matching the existing `step_created` behavior.
