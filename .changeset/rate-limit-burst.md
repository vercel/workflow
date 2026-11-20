---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-local': minor
'@workflow/world-vercel': minor
---

Add `burst` to `experimental_rateLimit()`: an idle key admits up to `burst` calls at once (1 to `limit`, default 1), then refills one per interval, like a token bucket.
