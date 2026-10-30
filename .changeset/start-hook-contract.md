---
'@workflow/world': minor
'@workflow/errors': minor
---

Add the atomic start Hook admission contract: `startHook` on `run_created`, the resilient `run_started` and the queued run input, the `atomicStartHook` capability, `startHookId()`, `WorkflowStartError`, the `START_HOOK_ADMISSION_DISABLED` and `START_HOOK_CANDIDATE_CANCELLED` codes, and a conformance suite. Admission creates the run's start Hook in the same atomic step: `run_created` stands for its `hook_created`, it accepts deliveries while the run is still `pending`, and it then follows the ordinary Hook lifecycle. `HookConflictError` gains `kind: 'start'` for a refused start.
