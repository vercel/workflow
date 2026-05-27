---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Add optional `lastKnownEventId` and `asOfTimestamp` params to `events.create`, which the World can use to do optimisti concurrency control fencing. Conflict surfaces as existing `EntityConflictError`, which the runtime already reloads-and-continues on.
