---
"@workflow/web": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
"@workflow/world-postgres": patch
"@workflow/world-local": patch
---

Strip only ref/payload fields from eventData when resolveData is 'none', preserving all other metadata
