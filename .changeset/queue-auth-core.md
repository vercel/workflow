---
"@workflow/core": minor
---

Refuse queue deliveries to the flow route that do not carry the World's in-process key with a 401, before touching any run; `WORKFLOW_QUEUE_AUTH=off` opts out except while dynamic workflows are enabled.
