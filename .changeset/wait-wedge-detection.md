---
'@workflow/core': patch
---

Detect wedged waits (a wait event write that conflicts while its event-log row is never readable) instead of silently wake-looping forever: warn within a tunable threshold (`WORKFLOW_WAIT_WEDGE_FAIL_AFTER_SECONDS`, default 10 minutes), then fail the run as `CORRUPTED_EVENT_LOG`.
