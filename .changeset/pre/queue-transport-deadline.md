---
'@workflow/world-vercel': patch
---

Give the queue client its own connection pool and a total per-request deadline, so a stalled queue acknowledgement fails fast instead of holding the invocation until the platform kills it.
