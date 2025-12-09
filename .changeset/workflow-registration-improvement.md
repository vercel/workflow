---
"@workflow/swc-plugin": patch
"@workflow/builders": patch
---

Improved workflow registration in workflow mode

- SWC plugin now emits `globalThis.__private_workflows.set(workflowId, fn)` directly after setting `workflowId`
- Non-exported workflow functions are now properly registered and can be invoked
- Removed runtime iteration over exports in the workflow bundle - registration happens at transform time
- Simplified virtual entry generation in base-builder

