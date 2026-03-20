---
"@workflow/core": patch
---

Reduce log severity for 409/429 logs from `warn` to `info`, as they can't be meaningfully acted on by the consumer.
