---
'@workflow/world-vercel': minor
---

Add a `dispatcher` option to `createVercelWorld` for supplying a custom undici dispatcher, used for both HTTP and queue requests. Defaults to the shared undici `RetryAgent`.
