---
'@workflow/world-vercel': patch
---

Compile each event type's create-event response schema once instead of on every event write, removing about 2.5 ms of CPU from each write.
