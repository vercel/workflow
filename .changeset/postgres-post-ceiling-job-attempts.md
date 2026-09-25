---
'@workflow/world-postgres': patch
---

Leave job attempts past core's max-deliveries ceiling, so a run whose terminal `run_failed` write fails transiently at the ceiling is retried instead of stranded when the job runs out of attempts. Jobs enqueued before this release keep their stored cap of 49 attempts (executor transfers carry it forward); only jobs enqueued after upgrading get the headroom.
