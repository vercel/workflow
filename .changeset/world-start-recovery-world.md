---
'@workflow/world': minor
---

Add `cancelActiveRuns()` (alongside `reenqueueActiveRuns`) and a `StartOptions { onRestart: 'recover' | 'cancel' | 'ignore' }` argument to the `start()` contract, so worlds can cancel in-flight runs at boot (the development behavior) instead of recovering them. Adds an optional `reason` to the `run_cancelled` event to record why. Also documents that `start()` must be idempotent and may be a no-op for push-based/serverless worlds.
