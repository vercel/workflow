---
"@workflow/world-postgres": patch
---

A zero-retention spec 9 run's data is purged after its terminal write commits, so a race's loser settling at the same moment can no longer deadlock the purge and leave the data in place; a purge Postgres fails to break a deadlock is retried.
