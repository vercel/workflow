---
'@workflow/core': patch
---

Never ack the orchestrator's queue message before the events that make the run progress are durably written. The suspension handler used to register the `step_created` / `wait_created` writes on a detached `waitUntil(Promise.all(ops))` in addition to awaiting them; the detached copy framed those progress-critical writes as droppable background work and re-threw send failures into a promise nothing consumes (unhandled rejection → process exit 128). It now strictly awaits the writes only, so the orchestrator message is never acked until they complete — a crash before then leaves the message un-acked and VQS redelivers within the lease, re-creating the (idempotent) entities and re-dispatching instead of orphaning the step. Complements the crash fix in #2336.
