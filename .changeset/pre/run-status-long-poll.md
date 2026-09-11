---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-local': minor
'@workflow/world-postgres': minor
'@workflow/world-vercel': minor
---

Add `world.runs.waitForTerminalStatus(runId, { timeoutMs, signal, resolveData })` method, which long-polls until the run reaches a terminal status. `await run.returnValue` now internally uses this, if the World supports it, instead of using a polling interval.
