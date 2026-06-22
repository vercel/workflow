---
'@workflow/core': patch
---

Refine `WORKFLOW_TRACE_MODE=linked` (the default) so each queue-delivered `workflow.execute` / `step.execute` span nests under its local delivery context instead of starting a new trace root.
