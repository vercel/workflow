---
'@workflow/core': patch
---

A far-future open wait (for example a `sleep()` that lost a `Promise.race()` against a hook) no longer disables the per-step event-log delta or turbo's optimistic start; only waits due within `WORKFLOW_IMMINENT_WAIT_HORIZON_MS` do.
