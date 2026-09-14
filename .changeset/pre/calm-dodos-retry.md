---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/world-postgres': patch
---

Retry replay timeouts through normal queue redelivery instead of exiting the process, and keep Postgres jobs retryable through Core's terminal delivery limit.
