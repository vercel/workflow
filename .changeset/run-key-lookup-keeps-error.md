---
'@workflow/errors': patch
'@workflow/core': patch
---

Stop reporting a failed encryption key lookup in `getSerializeStream` as a fatal `SerializationError`. A transient world error (transport, timeout, 429, 5xx) now surfaces as itself so the step retries; any other lookup failure is a fatal `EncryptionKeyLookupError`.
