---
'@workflow/core': patch
---

Add a `namespace` option to `start()`, `recreateRunFromExisting()`, `reenqueueRun()`, and `wakeUpRun()` for targeting deployments with namespaced queue topics, and make `healthCheck()` respect its timeout when the stream read hangs.
