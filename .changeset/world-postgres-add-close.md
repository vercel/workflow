---
"@workflow/world-postgres": patch
---

Implement `World.close()` to stop PgBoss and close the postgres connection pool so the process can exit cleanly
