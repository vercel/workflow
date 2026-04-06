---
'@workflow/core': patch
---

Cap stream flush batches to server's MAX_CHUNKS_PER_BATCH limit (1000) to prevent 400 errors
