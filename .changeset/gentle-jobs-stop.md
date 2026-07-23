---
'@workflow/world-postgres': patch
---

Abort stalled Postgres queue HTTP delivery during shutdown, wait for Graphile Worker to finish before closing dependencies, and allow applications to manage shutdown.
