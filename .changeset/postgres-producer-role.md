---
'@workflow/world-postgres': minor
---

Add a `role` option (`'producer' | 'worker'`, default `'worker'`, env fallback `WORKFLOW_POSTGRES_ROLE`) so a process that only enqueues can skip the Graphile Worker runner and startup recovery. A `'producer'` World still ensures the schema on `start()`, so it can enqueue into a fresh database, but never claims jobs it cannot execute and never re-enqueues runs another process owns.
