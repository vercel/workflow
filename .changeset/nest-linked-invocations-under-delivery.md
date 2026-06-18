---
'@workflow/core': patch
'workflow': patch
---

Refine `WORKFLOW_TRACE_MODE=linked` (the default) so each queue-delivered `workflow.execute` / `step.execute` span nests under its local delivery context instead of starting a new trace root. One invocation — route handler, replay, inline steps, and event writes — is now a single bounded trace, with a span link to the run-origin context (still a link, never a parent, and re-enqueues forward the original carrier unchanged, so a long-running run is never stitched into one giant trace across invocations).

Previously the framework route/server span and the workflow execution span landed in separate traces connected only by a link; they now share one trace per invocation. With no HTTP-server span active, the invocation span is a clean root rather than an orphan. `continuous` mode is unchanged.
