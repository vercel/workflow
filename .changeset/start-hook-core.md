---
'@workflow/core': minor
'workflow': minor
---

Add `start(workflow, args, { hook: { token, metadata, experimental_minRetention } })`, which admits the run and creates its start Hook in one atomic step, and throws `HookConflictError` naming the owner for a duplicate, which never becomes a run. `resumeHook(token)` works as soon as the run is admitted, and payloads sent before the workflow calls `createHook({ token })` are delivered in order once it does; that `createHook()` binds to the start Hook without registering a new one. Disposing the start Hook releases the token immediately; otherwise the run's end releases it, after any `experimental_minRetention` (there is no default retention). `cancel()` of a candidate that never became a run fences it.
