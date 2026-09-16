---
'@workflow/core': patch
---

Advance the workflow's deterministic clock when an entity completion reaches the workflow, not when the event is read from the log, so `Date.now()` no longer depends on how much of the log a replay loaded, fixing Date determinism across concurrent replays.
