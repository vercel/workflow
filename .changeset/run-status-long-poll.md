---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-local': minor
'@workflow/world-postgres': minor
'@workflow/world-vercel': minor
---

Resolve `await run.returnValue` as soon as a run finishes, via a new optional World long poll.

`Storage['runs']` gains `waitForTerminalStatus(runId, { timeoutMs, signal, resolveData })`: one read the World holds open until the run reaches a terminal status, returning the same entity `runs.get()` returns (a budget that expires returns the latest snapshot, not an error). `Run#pollReturnValue` uses it when the World implements it, so a run that finishes mid-wait is reported immediately instead of at the next poll tick — previously up to a full `WORKFLOW_RETURN_VALUE_POLL_INTERVAL_MS` (1s) later.

Implemented by `world-vercel` against workflow-server's new long-pollable `GET /v2/runs/:runId/status` route, by `world-postgres` with `LISTEN`/`NOTIFY` on run-terminal writes, and by `world-local` with an in-process signal over the run files. Every implementation re-reads the run before answering and backstops the wait with a periodic re-read, so a lost notification costs latency rather than correctness.

The method is optional and the fast path is strictly additive: a World that omits it (`world-sim`, third-party adapters) keeps interval-polling `runs.get()` exactly as before, and `world-vercel` falls back to the plain read when the workflow-server it is talking to has no such route. `WORKFLOW_RETURN_VALUE_LONG_POLL=0` restores interval polling everywhere; `WORKFLOW_RETURN_VALUE_WAIT_MS` tunes the per-call budget (default 25s).
