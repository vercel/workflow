---
'@workflow/world-local': patch
---

Fix `world-local` turning duplicate processing of the same `hook_created` (same `runId`, `hookId`, and token) into a self-conflict; it now throws `EntityConflictError` and is idempotent, matching the existing `step_created` behavior.
