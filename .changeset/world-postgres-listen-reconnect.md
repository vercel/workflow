---
"@workflow/world-postgres": patch
---

Handle errors on the dedicated `LISTEN` connection and reconnect after it drops, so a database restart no longer ends the process.
