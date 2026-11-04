---
"@workflow/core": patch
---

Label `workflow.queue.delivery.refused` with the flow route template instead of the request path, so forged requests cannot create unbounded metric series.
