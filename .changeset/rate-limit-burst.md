---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-local': minor
'@workflow/world-vercel': minor
---

Add `burst` to `experimental_rateLimit()`: an idle key admits up to `burst` calls at once (default 1, and up to a day of the rate, so it may exceed `limit`), then refills one per interval, like a token bucket.
