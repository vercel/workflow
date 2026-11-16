---
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Experimental: `QueueOptions.experimental_hold` (`true`, or `{ consumerGroup, visibilityTimeoutSeconds }`) asks the queue to claim a message for its sender before `queue()` returns, so the sender can run it in the request that sent it (the result's `experimental_hold` is `{ status: 'held', consume, release, ... }` or `{ status: 'not_held', reason }`; `consume(handler)` takes the same handler and delivery semantics as `createQueueHandler`), with the queue as the crash backstop.
