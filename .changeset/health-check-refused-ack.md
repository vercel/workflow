---
"@workflow/core": patch
---

Acknowledge a health-check probe whose response the World refuses with a non-retryable 4xx, instead of rethrowing and having the queue redeliver it until the message expires.
