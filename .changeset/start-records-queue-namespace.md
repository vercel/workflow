---
"@workflow/core": patch
---

Record the queue namespace on a run's `executionContext.queueNamespace` in `start()`, so restart recovery re-enqueues the run to its own namespace.
