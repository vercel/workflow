---
'@workflow/core': patch
---

Resolve a run's encryption key from metadata only, so `Run#getReadable()` no longer makes the server resolve the run's whole input and output before the stream's first chunk.
