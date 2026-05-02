---
"@workflow/world-postgres": minor
---

Add `noPreparedStatements` option (and `WORKFLOW_POSTGRES_NO_PREPARED_STATEMENTS` env var) that forwards graphile-worker's `noPreparedStatements: true` to its internal `run()` and `makeWorkerUtils()` calls. Required for pools that cannot honour per-session prepared statements, such as PgBouncer in transaction pooling mode or PGlite-socket (PGlite multiplexes many TCP clients onto a single WASM session).
