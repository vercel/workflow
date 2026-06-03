---
'@workflow/core': patch
---

Log the event log (event identities and ordering, without payloads) on every workflow run replay, and (diagnostically) fail the run on the first replay divergence instead of redriving via the queue, so replay divergences become immediately visible for investigation.
