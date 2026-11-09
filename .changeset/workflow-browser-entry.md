---
"workflow": patch
"@workflow/core": patch
---

Resolve the `workflow` package root to a browser build under the `browser` export condition, so client code that reaches `workflow` (a shared module that calls `defineHook()`, or `@ai-sdk/workflow`'s root entry) bundles without Node.js-only modules. It has the same exports: the error classes work, and the workflow and step APIs throw `NotInWorkflowOrStepContextError` when called. Edge and worker bundles keep the host build.
