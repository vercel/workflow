---
"@workflow/web": patch
"@workflow/world-postgres": patch
"@workflow/world-testing": patch
"docs": patch
---

feat(world-postgres): replace pg-boss with graphile-worker

- Replace PgBoss with Graphile Worker for workflow/step job queue; no schema changes
- Docs, known-worlds registration, and message/queue types for the new queue
