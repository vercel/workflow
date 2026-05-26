---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Add an optimistic-concurrency fence to event writes that talk to workflow-server.

- The elapsed-wait scan now passes `lastKnownEventId` snapshotted from the loaded events when committing `wait_completed`, so a stale-snapshot tick can't slip a sleep-branch event past a freshly-committed `hook_received`.
- `resumeHook` sends `asOfTimestamp` with the new `hook_received` event so the server-side fence is anchored at the resume call's wall-clock without paying for a client-side event pre-read.
- The `CreateEventParams` shape on `@workflow/world` grows two optional fields (`lastKnownEventId`, `asOfTimestamp`) that worlds may forward as-is.

Conflict surfaces as the existing `EntityConflictError`, which the runtime already reloads-and-continues on.
