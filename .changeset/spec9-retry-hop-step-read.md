---
"@workflow/core": patch
---

Spec 9: a background step's early redelivery while a `retryAfter` is still ahead now decides from the step's latest event (one newest-first `listByCorrelationId` read without payloads) instead of reading the run's whole log. Each step delivery's span records what it read (`step.delivery.log_read`).
