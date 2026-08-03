---
"@workflow/core": minor
"workflow": minor
---

`start()` now delegates run ID generation to `world.createRunId(options)` when the world provides it, falling back to a monotonic ULID otherwise. The full options bag is passed through so worlds can read whichever fields they recognise. Adds a new `region` option that worlds may consume — when set, it is also forwarded onto the queue options so the initial workflow message is routed to the matching region.
