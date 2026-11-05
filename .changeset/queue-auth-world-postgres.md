---
"@workflow/world-postgres": minor
---

Declare `queueAuthMode: 'skip'` until messages are delivered in-process (#5258); protect the flow route at the network edge. The internal Local World only reads the queue auth key, so a Postgres app creates no key file or `.workflow-data` directory.
