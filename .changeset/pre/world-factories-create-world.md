---
"@workflow/builders": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/world-vercel": patch
"@workflow/core": patch
"@workflow/next": patch
"@workflow/nest": patch
"workflow": patch
---

Standardize first-party World packages on `createWorld()`, support relative target World modules consistently, and align the Postgres World `DATABASE_URL` fallback with bootstrap.
