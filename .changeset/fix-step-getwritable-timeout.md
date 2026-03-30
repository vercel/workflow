---
"@workflow/core": patch
---

Fix `getWritable()` in step functions to resolve on lock release instead of requiring stream close, preventing Vercel function timeouts
