---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-vercel': minor
---

The cross-deployment capability probe now returns the target run's public key, letting `start()` seal workflow arguments without a separate key-lookup request.
