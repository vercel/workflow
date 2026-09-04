---
'@workflow/world': patch
'@workflow/core': patch
---

Emit `workflowName` on per-step events (`step_created`, `step_completed`, and lazy-start `step_started`) so Worlds can access it without additional queries
