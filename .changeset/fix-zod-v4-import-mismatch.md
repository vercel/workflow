---
'@workflow/world-local': patch
'@workflow/world-vercel': patch
'@workflow/world-postgres': patch
---

Fix zod v3/v4 schema mismatch crash (`keyValidator._parse is not a function`) by using consistent `zod/v4` imports in queue files that consume v4-native schemas from `@workflow/world`
