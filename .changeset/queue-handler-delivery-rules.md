---
'@workflow/world': patch
---

Document what a queue handler can rely on in `createQueueHandler`'s JSDoc: a throw brings the same message back with `attempt` incremented, a World should do the same after a crash, and a return means done, with a `{ timeoutSeconds }` wake whose identity is World-specific. No API change.
