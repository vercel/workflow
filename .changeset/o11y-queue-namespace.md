---
'@workflow/core': patch
---

Add a `namespace` option to `start()`, `recreateRunFromExisting()`, `reenqueueRun()`, and `wakeUpRun()` so cross-context callers (e.g. the observability dashboard) can target deployments that use a queue namespace (`__{namespace}_wkf_workflow_*` topics), and bound `healthCheck()`'s stream read by its timeout so probes against unresponsive deployments fail at the configured deadline instead of hanging.
