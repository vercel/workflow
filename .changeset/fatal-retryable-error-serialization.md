---
"@workflow/errors": patch
---

Add `WORKFLOW_SERIALIZE` / `WORKFLOW_DESERIALIZE` to `FatalError` and `RetryableError`, enabling the SWC plugin to discover and register them for class-based serialization
