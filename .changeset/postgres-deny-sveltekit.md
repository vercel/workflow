---
"@workflow/sveltekit": minor
---

Generate `worker.js` next to the flow route's `+server.js`; import it from `hooks.server.ts` (`init`) and call `startWorkflowWorker()` to run the process as a worker for a World that delivers in process (the Postgres World).
