---
'@workflow/world': patch
---

Document the `start()` contract: it must be idempotent and may be a no-op for push-based/serverless worlds, and is where queue-backed worlds run boot-time recovery.
