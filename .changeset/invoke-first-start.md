---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Single-owner runs start on their owner: `start()` sends the run's creation input through invoke, and the owner creates the run as the first event of its own session, starts executing without waiting for the connection, and arms a delayed wake carrying the same input as a backup. A failed start invocation fails `start()`; the run is never created from the caller. With `experimental_durableRunCreated` (or `WORKFLOW_DURABLE_RUN_CREATED=1`) the owner runs no step until `run_created` is durable, and `start()` resolves as soon as the run exists.
