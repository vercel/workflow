---
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Add `world.events.createBatch` World API method, which allows writing ordered events in one durable write, returning per-event outcomes. Optional. On by default if implemented by the World. Disable with `WORKFLOW_BATCH_TRANSITIONS=0`.
