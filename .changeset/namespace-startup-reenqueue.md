---
'@workflow/world': patch
---

`reenqueueActiveRuns` now builds queue names with the active queue namespace (`WORKFLOW_QUEUE_NAMESPACE`, or a new optional `namespace` argument). Startup recovery previously always enqueued to the un-namespaced `__wkf_workflow_` queue; a handler registered under a namespaced prefix rejects those deliveries with `Unhandled queue`, leaving every recovered run in an endless retry loop after a world restart.
