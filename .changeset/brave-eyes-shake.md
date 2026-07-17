---
'@workflow/world-local': minor
---

Add `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS` env var as a fallback for the `recoverActiveRuns` option, so re-enqueueing of pending/running runs on startup can be disabled without a custom world module.
