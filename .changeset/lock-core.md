---
"@workflow/core": minor
---

Add `experimental_lock(key, { concurrency })`, a native distributed semaphore for workflow functions on both workflow VMs; waiters queue FIFO and are woken by the releasing run, without growing their event log while they wait.
