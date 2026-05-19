---
"@workflow/world-postgres": patch
---

`workflow-postgres-setup` now also bootstraps the `graphile_worker` schema, so concurrent `world.start()` callers (e.g. dev server + test runner on a fresh DB) don't race on the not-race-safe `CREATE SCHEMA IF NOT EXISTS` and fail with `duplicate key value violates unique constraint "pg_namespace_nspname_index"`.
