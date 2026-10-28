---
'@workflow/core': minor
'workflow': minor
---

Add `start(workflow, args, { hook: { token, metadata, experimental_minRetention } })`, which admits at most one run per Hook token and throws `HookConflictError` naming the owner for a duplicate. `cancel()` of a candidate that never became a run fences it, and inside a step a lookup of a reserved token waits up to 30s for its owner.
