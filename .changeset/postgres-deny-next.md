---
"@workflow/next": minor
---

Generate `flow/worker.js` next to the flow route, and inline `WORKFLOW_IN_PROCESS_WORKER` (`"1"` when the build targets the Postgres World, else `""`) so `instrumentation.ts` can import the worker module behind a constant the bundler drops for other Worlds; call its `startWorkflowWorker()` to run the process as a worker. In `next dev`, a rebuilt route re-registers itself, so workflow edits take effect without a restart.
