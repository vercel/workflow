---
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Treat transient world-vercel transport failures as retryable, surfacing them as a `TRANSPORT` type `WorkflowWorldError`, to be retried by the queue instead of failing the run.
