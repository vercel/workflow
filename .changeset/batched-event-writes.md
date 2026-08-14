---
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Batched event writes: add the optional `events.createBatch` World API (ordered events, one durable write, per-event outcomes), implement it in `@workflow/world-vercel` against `POST /v4/runs/:runId/events/batch` (slot-identity runs only), and fold clean suspension fan-outs — eager `step_created` and `wait_created` writes — into batched writes in the runtime. On by default; disable with `WORKFLOW_BATCH_TRANSITIONS=0`.
