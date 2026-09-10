---
'@workflow/world': patch
'@workflow/core': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
'@workflow/world-testing': patch
---

**Breaking**: New runs are created at spec version 6, and a World that declares an older spec version is now rejected before the first run rather than failing partway through one.
