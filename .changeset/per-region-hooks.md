---
"@workflow/core": minor
"workflow": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
"@workflow/errors": patch
"@workflow/web": patch
"@workflow/web-shared": patch
"@workflow/world-postgres": patch
---

Add a `region` option to `createHook()`, `createWebhook()`, `resumeHook()` and `getHookByToken()`. On the Vercel World hook tokens are unique per region and stored in `iad1` unless a region is specified; webhooks default to their run's region, which their generated token carries.
