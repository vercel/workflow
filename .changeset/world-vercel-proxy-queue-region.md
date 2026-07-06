---
"@workflow/world-vercel": patch
---

Send the `x-vercel-queue-region` header on proxy-mode queue sends so they route to the region's VQS dataplane host like direct in-function sends do.
