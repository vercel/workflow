---
'@workflow/world-postgres': patch
---

Fix `readFromStream` erroring the whole stream — and dropping every chunk still queued — when rows were written after the stream's first EOF marker (e.g. a producer that retried its terminal write). Rows past the first EOF are now ignored.
