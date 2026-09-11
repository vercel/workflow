---
'@workflow/world-vercel': patch
'@workflow/world-postgres': patch
'@workflow/world-testing': patch
'@workflow/world-local': patch
'@workflow/core': patch
'@workflow/world': patch
'@workflow/cli': patch
'@workflow/ai': patch
'workflow': patch
---

Widen the published `zod` and `undici` ranges to carets so they deduplicate with other packages in an app instead of installing a second copy.
