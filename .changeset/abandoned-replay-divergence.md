---
'@workflow/core': patch
---

Stop an unrunnable run from taking the process down. When building a workflow session failed — most often a non-terminal run whose workflow is not registered in the current deployment — the event walk was left armed with a deferred unconsumed-event check on a timer. The check fired after the run had already been recorded as failed and rejected an interruption promise nobody was holding, so the `ReplayDivergenceError` escaped as a process-level `unhandledRejection` and killed every other run in flight in that worker. The abandoned session is now retired when the build throws, and the interruption promise always carries a handler.
