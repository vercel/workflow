---
'@workflow/core': patch
---

Cancel a `WorkflowServerReadableStream` connection that arrives after the consumer cancelled, instead of leaking it.
