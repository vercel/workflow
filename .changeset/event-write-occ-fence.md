---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Add optional `lastKnownEventId` param to `events.create`, which the World can use to do optimistic concurrency control fencing on branch-decision event writes. Fence conflict surfaces as `EntityConflictError`, which the runtime treats as a signal that another invocation has the canonical view of the event log: the current write is dropped (no retry, no `run_failed`) and the canonical invocation is left to make progress.
