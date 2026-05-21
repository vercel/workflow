---
"@workflow/core": minor
"workflow": minor
---

Support forwarding a `WritableStream` (from a workflow's `getWritable()`) as an argument to a child workflow via `start()`. The child run's writes land on the parent run's stream directly — encrypted with the parent run's key — for the full lifetime of the child run, with no in-process bridge tied to the parent step that invoked `start()`.
