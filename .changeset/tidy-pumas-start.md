---
'@workflow/world-vercel': patch
---

Classify HTTP/2 response stream timeouts as retryable transport failures so `start()` can return the queued run through resilient start.
