---
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/utils": patch
---

Add optional `Queue.registerRoute()` and `Queue.registerHandler()`, implemented by `@workflow/world-local` and `@workflow/world-postgres`, so a queue consumer other than the Workflow SDK receives its own prefix's messages on its own route or in process. `reenqueueActiveRuns()` re-enqueues a run to the queue namespace it recorded, and `@workflow/world-postgres` keeps a job's queue prefix.
