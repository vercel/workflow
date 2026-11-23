---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-sim': patch
---

Send every message to an existing run to the queue namespace the run recorded when it started, instead of the calling process's `WORKFLOW_QUEUE_NAMESPACE`. This covers a cancelled run's wake-up, `wakeUpRun`, `reenqueueRun`, the wake `resumeHook()` publishes, and the wake sent to a run whose hook was force-claimed. `HookResumeContext` and `HookClaimedFrom` gain an optional `queueNamespace`. A cancel or resume from a process without the run's environment no longer sends to the wrong queue.
