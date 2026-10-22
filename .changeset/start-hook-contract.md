---
'@workflow/world': minor
'@workflow/errors': minor
---

Add the atomic start Hook admission contract: `startHook` (with optional metadata) on `run_created`, resilient `run_started` and the queued run input, the `atomicStartHook` capability, `WorkflowStartError`, `HookReservedError` for a reserved token whose run has not registered its Hook, and a conformance suite.
