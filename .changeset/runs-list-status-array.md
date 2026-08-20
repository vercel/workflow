---
'@workflow/world': minor
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Allow `runs.list({ status })` to accept an array of statuses so callers can express set filters (e.g. non-terminal runs) without restating the status vocabulary. Both world backends fan out the array server-side. `reenqueueActiveRuns` uses this to collapse its per-status loop into a single paginated call. Backwards-compatible — the single-string form still works.
