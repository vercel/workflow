---
'@workflow/web': minor
---

The runs table now bulk-cancels selected runs in a single request via `bulkCancelRuns`, caps a batch at 500 runs, and reports a single outcome-summary toast.
