---
'@workflow/errors': patch
'@workflow/core': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
---

Add `HookNotFoundError` to `@workflow/errors` and adopt it across all world backends
