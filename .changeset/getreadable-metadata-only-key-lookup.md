---
'@workflow/core': patch
---

Resolve a run's encryption key from metadata only, so `Run#getReadable()` and resuming a hook stored without a resume context no longer make the server resolve the run's whole input and output first.
