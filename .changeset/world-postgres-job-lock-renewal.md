---
'@workflow/world-postgres': minor
---

Renew a running delivery's Graphile job lock, and redeliver a job whose process died once its lock has gone unrenewed for `jobLockStaleSeconds` (`WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS`, default 300, `0` disables) instead of after Graphile Worker's fixed 4 hours or the next restart.
