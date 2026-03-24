---
'@workflow/errors': patch
'@workflow/core': patch
---

Add `HookConflictError` to `@workflow/errors` and use it for hook token conflicts instead of `WorkflowRuntimeError`
