---
'workflow': minor
'@workflow/core': minor
'@workflow/world-vercel': minor
'@workflow/world': minor
'@workflow/errors': minor
---

Add an optimistic-concurrency guard for event creation (on by default; opt out with `WORKFLOW_PRECONDITION_GUARD=0`): replay-context event creations send a `stateUpdatedAt` snapshot timestamp, and the runtime reloads the event log and retries (then falls back to a fresh re-invocation) when the backend reports a newer out-of-band event with a 412 `PreconditionFailedError`. Backends without guard support ignore the snapshot, so this is backward-compatible and fails open.
