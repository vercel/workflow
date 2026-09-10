---
'@workflow/world': patch
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Remove the `preconditionGuard` World capability. A stale replay-context write no longer needs to be rejected: a reader holds a prefix of the log, replay is deterministic on a prefix, and the writer's next write reports the events it was pushed past.
