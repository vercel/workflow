---
'@workflow/world-postgres': patch
---

Make zero-retention deletion atomic and recoverable after live failures or restore, fence late writers, and withhold admission and inspection until cleanup succeeds.
