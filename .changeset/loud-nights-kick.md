---
"@workflow/world-postgres": patch
---

Replace `postgres` (postgres.js) with `pg` (node-postgres) for Drizzle and Graphile Worker. Add optional `pool` on `createWorld` to share a `pg.Pool`; when provided
