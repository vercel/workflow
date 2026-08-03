---
"@workflow/world-postgres": patch
---

`workflow-postgres-setup` now also bootstraps the `graphile_worker` schema, fixing potential race on setup when starting the app and a test runner at the same time
