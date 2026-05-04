---
"@workflow/core": patch
---

Drain pending queue items at workflow completion instead of warning. Previously, operations called without an `await` (or as the last statement of a workflow) were dropped with a "uncommitted operation" warning — most importantly, `controller.abort()` called right before `return` never actually propagated to in-flight steps on other compute instances. The runtime now treats end-of-run as a final suspension: pending hook resumes, hook creations/disposals, sleep waits, and step queueings all commit to the event log before the run is marked terminal. Matches normal JS semantics where async work spawned by a function continues after the function returns.
