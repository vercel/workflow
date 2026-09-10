---
'@workflow/world': major
'@workflow/world-local': major
'@workflow/world-postgres': major
'@workflow/world-vercel': major
'@workflow/web': minor
---

**Breaking:** `events.listByCorrelationId` and `analytics.events.listByCorrelationId` now require a `runId`. A correlation id is unique within its run, not across runs, so an unscoped lookup answered with one event per run that numbered a step or wait the same.
