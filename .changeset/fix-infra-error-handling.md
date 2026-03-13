---
"@workflow/core": patch
---

Separate infrastructure vs user code error handling in workflow and step runtimes so transient network errors (ECONNRESET, etc.) propagate to the queue for retry instead of incorrectly marking runs as failed
