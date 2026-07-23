---
'@workflow/world-vercel': minor
---

Add a no-op `start()` for World-interface compliance. The Vercel World is push-based (VQS redelivery), so it needs no boot-time recovery.
