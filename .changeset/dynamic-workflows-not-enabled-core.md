---
'@workflow/core': patch
---

Throw `DynamicWorkflowsNotEnabledError` instead of `WorkflowRuntimeError` when dynamic workflows are not enabled, at `start()` and on delivery, so a run that fails on it is recorded as `USER_ERROR` instead of `RUNTIME_ERROR`. Code that caught this refusal with `WorkflowRuntimeError.is(err)` should check `DynamicWorkflowsNotEnabledError.is(err)` instead.
