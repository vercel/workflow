---
"@workflow/core": patch
---

Round-trip the `this` binding of bound step proxies through workflow serialization. Calling `.bind(thisArg)` on a step proxy now stashes `__boundThis` on the bound function in addition to preserving `stepId`/`__closureVarsFn`; the workflow-side reducer serializes that as `boundThis`, and the workflow- and step-bundle revivers re-bind / `apply()` the deserialized step body to the captured value. Without this, a `useStep(...).bind(this)` proxy passed as a step argument would lose its receiver and the body would see `this === undefined` when invoked from the step bundle.
