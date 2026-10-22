---
'@workflow/core': minor
'workflow': minor
---

Add `start(workflow, args, { hook: { token, metadata, experimental_minRetention } })`, which admits at most one run per Hook token (held for 24 hours from `start()` by default) and throws `HookConflictError` naming the owner for a duplicate. A refused start re-publishes a holder stuck pending, setup retries a `run_started` answered without its run, and a resilient `run_started` now forwards the run's `encryptionPublicKey`.
