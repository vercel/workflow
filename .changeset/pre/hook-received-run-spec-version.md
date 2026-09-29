---
'@workflow/core': patch
---

Stamp events written to another runtime's run (`hook_received` from `resumeHook`, `run_cancelled` from `Run.cancel()`, and the deployment-mismatch `run_failed`) with the run's spec version when it is older than the SDK's.
