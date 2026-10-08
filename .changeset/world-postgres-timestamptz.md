---
'@workflow/world-postgres': patch
---

Store timestamps as `timestamp with time zone` so `createdAt` is correct when the Postgres server or session is not in UTC. Migration 0026 converts the columns and repairs `created_at` values written by earlier versions.
