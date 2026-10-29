---
'@workflow/core': minor
'workflow': minor
---

Add `start(workflow, args, { hook: { token, metadata, experimental_minRetention } })`, which admits the run and creates its start Hook in one atomic step, and throws `HookConflictError` naming the owner for a duplicate, which never becomes a run. `resumeHook(token)` works as soon as the run is admitted, and payloads sent before the workflow calls `createHook({ token })` are delivered in order once it does; that `createHook()` binds to the start Hook without registering a new one. The token is released when the run ends, or after `experimental_minRetention` when set (disposing the Hook doesn't release it); there is no default retention. `cancel()` of a candidate that never became a run fences it.
