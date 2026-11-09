---
"@workflow/core": patch
---

In spec 9, on a run's first delivery (turbo mode), a step fan-out now starts its inline bodies while its creation batches commit. Background steps' messages still go out only once their creation committed.
