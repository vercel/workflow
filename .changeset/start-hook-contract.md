---
'@workflow/world': minor
'@workflow/errors': minor
---

Add the atomic start Hook admission contract: `startHook` on `run_created`, the resilient `run_started` and the queued run input, the `atomicStartHook` capability, the start Hook `startHookId(runId)` that admission creates (resumable at once, then an ordinary Hook), `WorkflowStartError`, the `START_HOOK_ADMISSION_DISABLED` and `START_HOOK_CANDIDATE_CANCELLED` codes, and a conformance suite.
