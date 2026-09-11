---
'@workflow/world-postgres': patch
---

Handle `error` on the dedicated `LISTEN` clients and on the World's own connection pool: a connection the server closes (restart, failover, idle reaper) is now reopened after a backoff instead of surfacing as an uncaught exception that took the host process down.
