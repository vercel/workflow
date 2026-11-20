---
"@workflow/world-vercel": patch
---

Retry a queue reschedule once, after 10 seconds, when the Vercel edge refuses it with a 403, instead of leaving the message on its 300-second claim. A 403 from Vercel Queues itself is still not retried.
