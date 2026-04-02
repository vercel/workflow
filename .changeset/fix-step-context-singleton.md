---
"@workflow/core": patch
---

Fix `getWorkflowMetadata()`/`getStepMetadata()` throwing "can only be called inside a workflow or step function" when called from a helper function on Vercel deployments. The step context `AsyncLocalStorage` is now a process-wide singleton via `Symbol.for()`, preventing dual-instance issues when bundlers create multiple copies of the module.
