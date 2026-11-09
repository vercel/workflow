---
"@workflow/next": minor
---

Generate `flow/worker.js` next to the flow route; import it from `instrumentation.ts` and call `startWorkflowWorker()` to run the process as a worker for a World that delivers in process (the Postgres World). In `next dev`, a rebuilt route re-registers itself, so workflow edits take effect without a restart.
