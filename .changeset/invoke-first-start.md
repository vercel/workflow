---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Experimental invoke-first start for retained runs (`WORKFLOW_INVOKE_FIRST_START=1`): `start()` sends the run's creation input to its owner, which creates the run as the first event of its own session, starts executing without waiting for the connection, and arms a delayed wake carrying the same input as a backup. `start()` accepts `experimental_routingKey` to co-locate runs on one owner; the World's `InvokeOptions.routingKey` and `RunInput.routingKey` carry it. With `experimental_durableRunCreated` (or `WORKFLOW_DURABLE_RUN_CREATED=1`) the owner runs no step until `run_created` is durable, and `start()` resolves as soon as the run exists.
