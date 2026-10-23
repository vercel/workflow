---
"@workflow/world": minor
"@workflow/world-vercel": patch
"@workflow/errors": patch
"@workflow/web-shared": patch
"@workflow/world-postgres": patch
---

Add the `hookRegions` World capability, an optional `region` on `hooks.getByToken()` and on `Hook`, and `HookNotFoundError.region`. `@workflow/world-vercel` forwards the region on by-token lookups. No behavior change yet.
