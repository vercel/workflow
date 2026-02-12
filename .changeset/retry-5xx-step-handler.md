---
"@workflow/core": patch
"@workflow/world-vercel": patch
---

Retry 5xx errors from workflow-server in step handler and queue operations to avoid consuming step attempts on transient infrastructure errors
