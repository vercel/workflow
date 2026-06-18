---
'@workflow/world': patch
'@workflow/core': patch
---

Emit `workflowName` on per-step events (`step_created`, `step_completed`) so Worlds can access it without additional queries
