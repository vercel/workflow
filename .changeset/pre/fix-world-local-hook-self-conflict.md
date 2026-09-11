---
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Fix `world-local` and `world-postgres` turning duplicate processing of the same `hook_created` (same `runId`, `hookId`, and token) into a self-conflict; both worlds now treat same-entity duplicates as idempotent (matching `step_created`), and recover crash-orphaned token claims (`world-local`) and hook rows (`world-postgres`) by completing the partial write instead of incorrectly suppressing it.
