---
'@workflow/core': patch
---

Advance the workflow's deterministic clock when an entity completion reaches the workflow, not when the event is read from the log, so `Date.now()` no longer depends on how much of the log a replay loaded, fixing Date determinism across concurrent replays. The clock now moves only on step results, hook payloads, wait completions, aborts and hook registration outcomes, so a run with many other events between deliveries reads an older time than before; a `sleep()` scheduled from it resumes relative to that time.
