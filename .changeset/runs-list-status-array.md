---
'@workflow/world': minor
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
---

Allow `runs.list({ status })` to accept an array of statuses so callers can easily express set filters (e.g. non-terminal runs). world-vercel does not yet support the array form and throws a clear `INVALID_ARGUMENT` error instead of a broken request.
