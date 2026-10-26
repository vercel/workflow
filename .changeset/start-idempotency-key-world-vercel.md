---
"@workflow/world-vercel": minor
---

Support run idempotency keys: forward them on `run_created`, map the backend's refusal to `WorkflowRunAlreadyStartedError`, and declare `capabilities.runIdempotencyKeys`.
