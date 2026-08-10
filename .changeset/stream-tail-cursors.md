---
'@workflow/web': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Return a checkpoint cursor after every non-empty stream chunk page so open streams can resume from their current tail without reloading the final page.
