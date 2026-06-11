---
'@workflow/utils': minor
'@workflow/core': minor
'workflow': minor
---

Nicer span names: workflow and step spans now use the short function name (e.g. `workflow.execute processOrder`, `step.execute chargeCard`, `workflow.start processOrder`) instead of the uppercase prefixes and full machine names (`WORKFLOW_V2 workflow//./src/jobs/order//processOrder`). The full name remains available in the `workflow.name` / `step.name` span attributes. New `workflowDisplayName` / `stepDisplayName` helpers are exported from `@workflow/utils`.
