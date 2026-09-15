---
'@workflow/core': patch
---

Don't observe idle — and raise a `WorkflowSuspension` — while a delivery that is committed to reaching the workflow is still parked between its serial queue slot and its detached `resolve()`. A run with an outstanding `sleep()` replaying a batch of parallel step results could suspend inside that gap with none of the batch's follow-up work queued, going dormant until an unrelated timer fired.
