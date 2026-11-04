---
"@workflow/world-local": patch
---

Retry a delivery refused with the queue auth 401 up to 5 times before giving it up, so in cluster mode a retry can reach the process whose key matches; refused deliveries do not count as attempts.
