---
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
'workflow': patch
---

Return a checkpoint cursor after every non-empty open-stream chunk page so consumers can resume after the last delivered chunk without replaying it.
