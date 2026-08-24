---
'@workflow/world': minor
'@workflow/world-vercel': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/web': patch
---

Accept and send an optional `runId` when listing events by correlation ID, so backends can scope the lookup to a single run.
