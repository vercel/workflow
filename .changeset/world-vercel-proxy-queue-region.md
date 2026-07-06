---
"@workflow/world-vercel": patch
---

Send the `x-vercel-queue-region` header on proxy-mode queue sends so the api.vercel.com workflow proxy forwards them to the region's VQS dataplane host, giving token/proxy clients parity with the direct in-function path (which already dials the regional host). Direct sends are unchanged.
