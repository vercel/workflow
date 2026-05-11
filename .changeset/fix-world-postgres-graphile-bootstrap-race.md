---
"@workflow/world-postgres": patch
---

Pre-create the `graphile_worker` schema under a Postgres advisory lock so concurrent `world.start()` callers (e.g. dev server + test runner, or multiple serverless invocations) don't race on the not-race-safe `CREATE SCHEMA IF NOT EXISTS` and fail with `duplicate key value violates unique constraint "pg_namespace_nspname_index"`. The lock is held on a short-lived dedicated connection that is released before `makeWorkerUtils()` runs so the bootstrap can't deadlock against the same pool when its max size is small.
