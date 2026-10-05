---
"@workflow/world-vercel": patch
---

Upgrade `@vercel/queue` to 0.8.0 so throttled queue sends honor the server's `Retry-After` and queue errors carry clean messages
