---
'@workflow/world-vercel': minor
---

Pass a queue handler's `visibilityTimeoutSeconds` to `@vercel/queue`, so a route can choose a shorter lease than the default 300 seconds. Values outside 30-3600 or non-integers throw a `RangeError` when the handler is created.
