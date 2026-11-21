---
"@workflow/core": patch
---

A spec 9 run on the node engine can resume the VM its previous delivery in the same process left suspended, on an incremental read of what landed since, instead of loading and replaying its whole log. Parking is opt-in: set `WORKFLOW_PARKED_VM_MAX_BYTES` to a memory budget, such as `8388608` (8 MiB), to turn it on.
