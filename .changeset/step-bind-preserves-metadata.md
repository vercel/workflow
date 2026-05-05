---
"@workflow/core": patch
---

Preserve `stepId` and `__closureVarsFn` metadata when calling `.bind(thisArg)` on a step proxy, so bound proxies still serialize correctly through the `StepFunction` reducer (e.g. when passed as step arguments).
