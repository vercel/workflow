---
'@workflow/core': patch
---

A pending `sleep()` that cannot fire during the current invocation (for example one that lost a `Promise.race()` against a hook) no longer costs an extra event-log read per step boundary. The window follows the invocation's inline budget plus `WORKFLOW_OPEN_WAIT_CLOCK_SKEW_MS`; a wait completed early via `run.wakeUp()` is picked up by a read before the run parks on it.
