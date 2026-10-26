---
'@workflow/core': minor
---

Use length-prefixed frames for real-time abort stream packets. Keep readers compatible with existing unframed packets, reassemble split transport reads, and retain unframed writes when targeting older deployments. Payload encryption and durable hook events are unchanged.
