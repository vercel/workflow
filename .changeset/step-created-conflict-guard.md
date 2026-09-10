---
'@workflow/core': patch
---

Fail a run as `CORRUPTED_EVENT_LOG` when a concurrent replay already created a step under the same correlation id but with a different step name or different arguments, instead of continuing and delivering that step's result to the wrong call.
