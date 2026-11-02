---
"@workflow/world-postgres": minor
---

Attach the process's in-memory queue auth key to every delivery and declare `queueAuth: 'in-process-key'`; a worker delivering to a route in another process now needs `WORKFLOW_QUEUE_AUTH=off` there.
