---
"@workflow/errors": patch
"@workflow/core": patch
"@workflow/world-local": patch
"@workflow/world-vercel": patch
"@workflow/world-postgres": patch
---

Replace HTTP status code checks with semantic error types (EntityConflictError, RunExpiredError, ThrottleError, TooEarlyError)
