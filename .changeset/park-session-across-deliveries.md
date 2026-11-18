---
"@workflow/core": patch
---

A spec 9 run on the node engine resumes the VM its previous delivery in the same process left suspended, on an incremental read of what landed since, instead of loading its whole log and replaying it from cold. A hook-driven run, such as a chat session, no longer pays a load and replay that grow with its history for each message that arrives after its orchestrator stopped lingering.

Parked VMs are capped at an estimated 8 MiB per process by default; set `WORKFLOW_PARKED_VM_MAX_BYTES` to change the budget, or `0` to turn parking off.
