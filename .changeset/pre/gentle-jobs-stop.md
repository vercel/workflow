---
'@workflow/world-postgres': patch
---

On shutdown, abort stalled workflow and step HTTP deliveries after Graphile Worker's grace period so their Postgres job rows are unlocked through normal failure handling instead of waiting for stale-lock recovery; aborted deliveries still consume an attempt and retry only when budget remains. Add opt-in application-managed shutdown through `applicationManagedShutdown` or `WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1` so applications can await `world.close()` before closing their HTTP server and caller-owned pool.
