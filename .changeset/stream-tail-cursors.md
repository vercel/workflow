---
'@workflow/web': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Return a checkpoint cursor after every non-empty open-stream chunk page so readers can resume from the current tail without reloading it.
