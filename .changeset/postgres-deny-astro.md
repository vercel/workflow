---
"@workflow/astro": minor
---

Generate `_worker.js` in the pages directory and emit it as a second server entry, `dist/server/workflow-worker.mjs`, whose `startWorkflowWorker()` a start script calls before the server entry to run the process as a worker for a World that delivers in process (the Postgres World); `astro dev` registers the route and starts such a World itself. The route is built once per module and exposes its in-process entry on `POST`.
