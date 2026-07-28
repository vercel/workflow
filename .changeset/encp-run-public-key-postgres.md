---
'@workflow/world-postgres': minor
---

Add an `encryption_public_key` column to `workflow_runs` (migration `0016`) to store each run's X25519 public key.
