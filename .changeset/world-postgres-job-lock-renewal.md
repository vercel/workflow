---
'@workflow/world-postgres': minor
---

Add `jobLockStaleSeconds` (`WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS`, default `0`, off). When set, a running delivery renews its Graphile job lock, and a job whose process died is redelivered by another process once its lock has gone unrenewed for that many seconds, instead of after Graphile Worker's fixed 4 hours or the next restart. `30` is a good value when more than one process shares the database.
