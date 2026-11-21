---
'@workflow/web': patch
'@workflow/web-shared': patch
---

On the Local World, a run's page gets a Usage tab and page (`/run/<runId>/usage`) that lists its events by type and its storage, the same table as `workflow inspect run <id> --usage`. `@workflow/web-shared` exports the trace's `ResourceIcon` for it.
