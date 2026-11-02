---
"@workflow/core": patch
---

Mark the queue auth 401 with `x-workflow-auth-refused` so senders treat it as permanent, and count refusals on the `workflow.queue.delivery.refused` OpenTelemetry counter.
