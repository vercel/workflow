---
"@workflow/world": minor
"@workflow/core": minor
"@workflow/errors": minor
"@workflow/world-postgres": minor
"@workflow/world-local": patch
"@workflow/world-vercel": patch
---

Add optional handler-return invocation delivery for hooks, with notification-driven Postgres inputs, idempotent hook writes, retention-aware typed outcomes, and run-scoped Graphile executor queues. Replay in-flight inputs before acknowledging their wake, retry transient failures, and restore known terminal Workflow errors to callers.
