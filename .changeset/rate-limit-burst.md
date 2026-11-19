---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-local': minor
'@workflow/world-vercel': minor
---

Add `burst: true` to `experimental_rateLimit()`: an idle key admits up to `limit` calls at once, then refills one per interval, like a token bucket.
