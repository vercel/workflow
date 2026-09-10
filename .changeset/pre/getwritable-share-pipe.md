---
"@workflow/core": patch
"workflow": patch
---

Fix `getWritable()` returning a new TransformStream per call, which caused racing pipes to reorder chunks when callers acquired a writer per write. Repeat calls within the same step now share a single pipe per `(runId, namespace)`.
