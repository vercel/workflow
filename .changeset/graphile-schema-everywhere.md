---
"@workflow/world-postgres": patch
---

The invoke executor's wake and delivery check use the configured `GRAPHILE_WORKER_SCHEMA` instead of always `graphile_worker`, as the rest of the World does.
