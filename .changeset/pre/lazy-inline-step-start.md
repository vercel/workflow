---
'workflow': patch
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
---

Lazy inline step start: the owned-inline runtime path now sends a single `step_started` carrying the step input, letting the world create the step on the fly and saving one round-trip per inline step.

`@workflow/world`: `step_started` event data accepts an optional `input`, and `EventResult` gains a `stepCreated` ownership signal.

`@workflow/world-local`: `step_started` with input atomically creates the step plus a synthetic `step_created` event; a lazy `step_started` for an already-existing step throws `EntityConflictError` so concurrent losers skip (exactly-once).

`@workflow/world-postgres`: same lazy-create + exactly-once create-claim for the Postgres backend.

`@workflow/world-vercel`: sends the step input on `step_started` over the v4 wire and threads the server's `stepCreated` signal into `EventResult`.
