---
'@workflow/world-postgres': patch
---

Fix `readFromStream` erroring when rows were written after the stream's first EOF marker. Rows past the first EOF are now ignored consistently across `streams.get()`, `getChunks()`, and `getInfo()`.
