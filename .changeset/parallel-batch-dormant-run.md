---
'@workflow/core': patch
---

Don't raise a suspension while a step, wait, or hook delivery that is committed to reaching the workflow is still parked behind `awaitEarlierDeliveries`' macrotask yield. A run with an outstanding `sleep()` that replayed a batch of parallel step results could observe idle between `pendingDeliveries` releasing and the deferred `resolve()` running, suspend with none of the batch's follow-up work queued, and go dormant until an unrelated timer fired.
