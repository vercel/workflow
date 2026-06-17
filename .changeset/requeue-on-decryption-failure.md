---
"@workflow/core": patch
---

Retry a bounded number of times via queue redelivery when a `RuntimeDecryptionError` occurs during replay on managed worlds, since the failure may stem from a transiently corrupted persisted-data read, before failing the run as `RUNTIME_ERROR`.
