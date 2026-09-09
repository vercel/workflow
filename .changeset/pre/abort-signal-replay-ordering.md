---
'@workflow/core': patch
---

Fix a race where an `AbortController` aborted from a step was not reflected in a `controller.signal` passed to a subsequent step. The step now commits the abort's durable hook event before completing, and the workflow's suspension waits for the abort to land before serializing downstream step arguments.
