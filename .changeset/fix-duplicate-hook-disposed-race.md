---
'@workflow/core': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Fix race condition allowing duplicate `hook_disposed` events for the same hook
