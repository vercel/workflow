---
"@workflow/core": minor
---

Refuse deliveries to the flow route without the app's queue key, for Worlds that declare `queueAuthMode: 'loopback'`, with a marked 401 before any run is touched, and count refusals on `workflow.queue.delivery.refused`. `WORKFLOW_QUEUE_AUTH=off` turns the check off, except while dynamic workflows are enabled.
