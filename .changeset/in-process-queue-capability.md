---
"@workflow/world": minor
---

Add optional `inProcessQueueHandlers` capability to the `Queue` interface, letting worlds declare that their queue executes messages via in-process registered handlers so route entrypoints register proactively.
