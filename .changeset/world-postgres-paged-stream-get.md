---
'@workflow/world-postgres': patch
---

Page `world-postgres` stream history reads to reduce memory usage and improve time-to-first-byte for large streams. Historical chunks are now fetched in batches of 64 while preserving `startIndex` and live-stream handoff behavior.
