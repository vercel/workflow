---
'@workflow/core': patch
---

Run-ahead keeps going past an open `sleep()` that comes due more than `WORKFLOW_OPEN_WAIT_CLOCK_SKEW_MS` (at least 1 s) from now.
