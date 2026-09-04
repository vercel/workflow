---
"@workflow/world-local": patch
---

Throw `WorkflowRunNotFoundError` when `run_failed` is recorded against a run that doesn't exist, matching the behaviour of `world-postgres` and `world-vercel`.
