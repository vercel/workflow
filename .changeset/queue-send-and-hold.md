---
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Experimental: `QueueOptions.experimental_hold` asks the queue to claim a message for its sender before `queue()` returns, so the sender can run it in the request that sent it (`experimental_held.consume(handler)`, the same handler and delivery semantics as `createQueueHandler`) with the queue as the crash backstop. A send that is not held reports `experimental_notHeld.reason` and is delivered as usual. Worlds declare support with `capabilities.experimental_queueHold`; `@workflow/world-vercel` implements it with `@vercel/queue`'s send-and-hold (0.11.0).
