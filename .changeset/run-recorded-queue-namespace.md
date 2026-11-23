---
'@workflow/core': patch
---

Send a cancelled run's wake-up, `wakeUpRun` and `reenqueueRun` messages to the queue namespace the run recorded when it started, instead of the calling process's `WORKFLOW_QUEUE_NAMESPACE`. A cancel from a process without the run's environment no longer sends to the wrong queue.
