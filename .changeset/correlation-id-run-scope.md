---
'@workflow/world': minor
'@workflow/world-local': minor
'@workflow/world-postgres': minor
'@workflow/world-vercel': minor
'@workflow/web': minor
---

Let `events.listByCorrelationId` take a `runId`, so a lookup for a step or wait returns that run's events and not every run that numbered one the same.
