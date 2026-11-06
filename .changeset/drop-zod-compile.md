---
"@workflow/world": patch
"@workflow/world-vercel": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/world-testing": patch
---

Validate with Zod's standard parser instead of `z.compile`, removing about 200 ms of schema compilation from each cold start without changing what is validated.
