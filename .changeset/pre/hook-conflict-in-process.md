---
'@workflow/core': patch
---

Settle a hook's awaiter in the invocation that wrote its `hook_created` or `hook_conflict`, instead of re-invoking through the queue and replaying. Falls back to an incremental read when the World returns no delta, and to the re-invocation under `WORKFLOW_RETAINED_VM=0`.
