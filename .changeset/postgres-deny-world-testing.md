---
"@workflow/world-testing": minor
---

Add conformance tests for Worlds that declare `queueAuthMode: 'deny'`: forged flow-route requests are refused with a 403 while runs still complete in process, refusals are counted, and `WORKFLOW_QUEUE_AUTH=off` reopens the route except under dynamic workflows. The conformance server registers its flow route with the World for in-process delivery.
