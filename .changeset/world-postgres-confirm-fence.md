---
"@workflow/world-postgres": patch
---

Check that a delivery still holds its job lock before every acknowledgement, not only when its renewals have stalled for half the stale window. While `jobLockStaleSeconds` is being changed across processes (from the default to `30`, say), a process with the shorter window could release a running delivery inside that span; the original delivery's unfenced acknowledgement then deleted the redelivery's job, and a failure of the redelivery was never retried.
