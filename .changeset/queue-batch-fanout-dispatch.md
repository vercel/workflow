---
'@workflow/world-vercel': patch
'@workflow/world': patch
'@workflow/core': patch
---

Publish a fan-out's step-execution messages in one batched queue request instead of one per step, via a new optional `Queue.queueBatch` implemented on `@vercel/queue`'s `experimental_sendBatch`.
