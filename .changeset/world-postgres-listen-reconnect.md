---
"@workflow/world-postgres": patch
---

Reconnect the stream and run-status `LISTEN` connection after the database drops it, instead of crashing the process.
