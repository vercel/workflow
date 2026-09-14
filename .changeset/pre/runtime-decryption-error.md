---
"@workflow/errors": patch
"@workflow/core": patch
---

Classify SDK-level AES-GCM encryption failures as `RUNTIME_ERROR` instead of `USER_ERROR` via a new `RuntimeDecryptionError`.
