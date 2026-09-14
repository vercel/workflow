---
"@workflow/core": minor
"workflow": minor
---

A `WritableStream` from a workflow's `getWritable()` can now be passed as an argument to a child workflow via `start()`; the child's writes land on the parent run's stream directly for the full lifetime of the child run.
