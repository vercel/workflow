---
'@workflow/core': patch
---

Keep a failed encryption key lookup in `getSerializeStream` as its own error instead of a fatal `SerializationError`, so a transient failure retries the step.
