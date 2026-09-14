---
'@workflow/core': patch
---

An open wait that cannot fire during the current invocation (for example a `sleep()` that lost a `Promise.race()` against a hook) no longer disables the per-step event-log delta or turbo's optimistic start. The window follows the function's duration, plus `WORKFLOW_OPEN_WAIT_CLOCK_SKEW_MS`.
