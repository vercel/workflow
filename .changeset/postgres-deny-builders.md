---
"@workflow/builders": minor
---

Generated flow routes call `refreshWorkflowHandler(POST)` when evaluated outside production, so a route rebuilt in development replaces the one registered at startup. Add `createWorkflowWorkerModuleCode()` (the module a startup hook imports to run the process as a worker) and `createWrappedWorkflowRouteCode()` for frameworks whose handlers take `{ request }`.
