---
'@workflow/core': patch
'workflow': patch
---

In `WORKFLOW_TRACE_MODE=linked` (the default), nest each queue-delivered `workflow.execute`/`step.execute` span under its delivery context — so the route handler and workflow execution share one trace per invocation — with a single span link to the run origin, instead of starting a new trace root. `continuous` mode is unchanged.
