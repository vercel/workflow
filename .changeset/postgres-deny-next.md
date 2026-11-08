---
"@workflow/next": minor
---

Generate `flow/worker.js` next to the flow route: import it from `instrumentation.ts` and call `startWorkflowWorker()` to run the process as a worker for a World that delivers in process (the Postgres World). After a rebuild in `next dev` the builder requests the route's health endpoint so the rebuilt route re-registers itself, and edits to workflow files take effect without a restart.
