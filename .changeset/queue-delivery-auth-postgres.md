---
"@workflow/world-postgres": minor
---

Authenticate worker deliveries with `WORKFLOW_QUEUE_SECRET`; without one, the flow route rejects deliveries unless `NODE_ENV` is `development` or `test`.
