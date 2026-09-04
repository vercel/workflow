---
'@workflow/world-postgres': patch
---

Fix Postgres step lifecycle event ordering so a late concurrent step_started is no longer logged after step_completed.
