---
"@workflow/builders": minor
---

Every generated flow route re-registers itself with the World when its module is evaluated in a process that runs as a worker (`refreshWorkflowHandler()`), so a route rebuilt in development replaces the one registered at startup. Add `createWorkflowWorkerModuleCode()`, the generated module an app imports from its startup hook (`registerWorkflowWorker()`, `startWorkflowWorker()`), and `createWrappedWorkflowRouteCode()` for frameworks whose handlers take `{ request }` (SvelteKit, Astro), which now build one `workflowEntrypoint()` per module and expose its in-process entry on `POST`.
