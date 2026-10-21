---
'@workflow/core': minor
'workflow': minor
---

Add `start(workflow, args, { hook: { token, experimental_minRetention } })`, which admits at most one run per Hook token and throws `HookConflictError` naming the owner for a duplicate. A resilient `run_started` now also forwards the run's `encryptionPublicKey`.
