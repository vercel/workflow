---
'@workflow/core': patch
'@workflow/errors': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Replay-context event writes now always report the log position they replayed from, and the `WORKFLOW_PRECONDITION_GUARD` flag is removed.
