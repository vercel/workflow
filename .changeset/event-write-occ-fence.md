---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Add optional `lastKnownEventId` param to `events.create`, which the World can use to do optimistic concurrency control fencing on branch-decision event writes. Conflict surfaces as existing `EntityConflictError`, which the runtime retries in place against a freshly-loaded fence.
