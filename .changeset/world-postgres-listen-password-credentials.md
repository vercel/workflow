---
"@workflow/world-postgres": patch
---

Fix LISTEN connections failing to authenticate when the World is given a `pg.Pool` that sets `password` or a password callback.
