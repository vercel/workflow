---
"@workflow/world-postgres": patch
---

Serialize graphile-worker schema bootstrap with a Postgres advisory lock to prevent `duplicate key value violates unique constraint "pg_namespace_nspname_index"` errors when multiple processes (e.g. dev server and test runner) call `world.start()` concurrently against a fresh database.
