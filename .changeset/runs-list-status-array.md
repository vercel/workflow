---
'@workflow/world': minor
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Allow `runs.list({ status })` to accept an array of statuses so callers can easily express set filters (e.g. non-terminal runs)
