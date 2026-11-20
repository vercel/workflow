---
"@workflow/world-vercel": patch
---

Retry a request to world-vercel once, 10 seconds later, when the Vercel Firewall denied it (403 with `x-vercel-mitigated: deny`). A 403 that world-vercel itself sent is still not retried.
