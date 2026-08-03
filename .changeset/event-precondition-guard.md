---
'workflow': minor
'@workflow/core': minor
'@workflow/world-vercel': minor
'@workflow/world': minor
'@workflow/errors': minor
---

Add an opt-in optimistic-concurrency guard for event creation (`WORKFLOW_PRECONDITION_GUARD=1`): replay-context event creations send a `stateUpdatedAt` snapshot timestamp, and the runtime reloads the event log and retries (then falls back to a queue re-invocation) when the backend reports a newer out-of-band event with a 412 `PreconditionFailedError`.
