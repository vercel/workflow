---
"@workflow/world-postgres": minor
---

Attach the process's in-memory queue auth key to every delivery and declare `queueAuth: 'in-process-key'`; a split worker tier (a worker delivering to a route served by another process) now needs `WORKFLOW_QUEUE_AUTH=off` on that route.
