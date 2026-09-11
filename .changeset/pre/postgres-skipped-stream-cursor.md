---
'@workflow/world-postgres': patch
---

Fix stream cursors not being advanced for skipped chunks, so repeated notifications cannot consume the requested start offset twice
