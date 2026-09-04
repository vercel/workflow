---
'@workflow/world': patch
---

Fix compatibility with Zod 4.4.x in `WorkflowRunSchema` by marking `output`, `error`, and `completedAt` as `.optional()` on non-final / cancelled / completed / failed run states.
