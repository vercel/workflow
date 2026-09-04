---
"@workflow/world-vercel": patch
---

Add a default request timeout to world-vercel HTTP calls so hanging responses can be re-tried sooner and run less risk of continuing until a function timeout
