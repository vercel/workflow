---
'@workflow/world': patch
---

Document what a queue handler can rely on in `createQueueHandler`'s JSDoc: a throw or a crash brings the same message back with `attempt` incremented, and a return means done, with a `{ timeoutSeconds }` wake whose identity is World-specific. No API change.
