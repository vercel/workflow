---
'@workflow/world': minor
---

`Queue.createQueueHandler` accepts an optional third argument, `QueueHandlerOptions`, with a per-handler `visibilityTimeoutSeconds`. Its JSDoc also says how `{ timeoutSeconds }` redelivers differ between Worlds.
