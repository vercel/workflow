---
'@workflow/core': patch
---

Advance the workflow's deterministic clock when a step result, hook payload or wait completion reaches the workflow, not when the event is read from the log, so `Date.now()` no longer depends on how much of the log a replay loaded; control flow that reads the clock (idle loops, deadlines) could otherwise draw different ordinals across replays and fail with `CORRUPTED_EVENT_LOG`.
