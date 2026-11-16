---
"@workflow/astro": minor
---

Emit `dist/server/workflow-worker.mjs` with the server build; a start script calls its `startWorkflowWorker()` before the server entry to run the process as a worker for a World that delivers in process (the Postgres World), and `astro dev` does both itself when `WORKFLOW_TARGET_WORLD` names such a World.
