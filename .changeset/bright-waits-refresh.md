---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
---

Refresh workflow events after completing elapsed waits so concurrent hook events preserve deterministic replay order.
