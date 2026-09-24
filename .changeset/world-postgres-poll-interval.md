---
'@workflow/world-postgres': patch
---

Add `pollInterval` config option and `WORKFLOW_POSTGRES_POLL_INTERVAL_MS` env var to control the graphile-worker idle poll interval, which was previously hardcoded to 500ms. Each `queueConcurrency` worker polls independently at this interval, so the idle job-fetch rate scales with `queueConcurrency × 1000 / pollInterval` per second. Defaults to 500ms, matching prior behavior.
