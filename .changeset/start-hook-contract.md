---
'@workflow/world': minor
'@workflow/errors': minor
---

Add the atomic start Hook admission contract: `startHook` on `run_created`, the resilient `run_started` and the queued run input, the `atomicStartHook` capability, `WorkflowStartError`, `HookReservedError`, the `START_HOOK_ADMISSION_DISABLED` and `START_HOOK_CANDIDATE_CANCELLED` codes, `forceRefusedReason: 'start-reservation'` on `hook_conflict`, and a conformance suite.
