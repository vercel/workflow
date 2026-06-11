---
'@workflow/core': patch
---

Strictly await `step_created` / `wait_created` writes in the suspension handler instead of also registering them on a detached `waitUntil`, so the orchestrator's queue message is never acked before the events that make the run progress are durable. A crash before then leaves the message un-acked for VQS to redeliver and replay, rather than orphaning the step. Also removes the re-throw that turned send failures into an unhandled rejection (process exit 128). Complements #2336.
