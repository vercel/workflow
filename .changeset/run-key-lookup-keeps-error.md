---
'@workflow/errors': patch
'@workflow/core': patch
---

Retry steps whose stream encryption key lookup fails transiently instead of failing them with a `SerializationError`
