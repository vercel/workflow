---
'@workflow/world-vercel': patch
---

Retry 429 (ThrottleError) event writes in-process, honoring the server's `Retry-After`, bounded by a 30s cumulative wait budget per write. Previously a throttled event write escaped to the queue handler, whose retry directive can be delayed up to ~5 minutes by queue redelivery scheduling.
