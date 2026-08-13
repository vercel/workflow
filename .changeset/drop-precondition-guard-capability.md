---
'@workflow/world': patch
'@workflow/core': patch
---

Remove the `preconditionGuard` World capability. Every World is now assumed to be able to reject a stale replay-context write, so the behaviors that keyed on the flag apply everywhere.
