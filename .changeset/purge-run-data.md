---
"@workflow/world": minor
"@workflow/world-vercel": minor
"@workflow/core": minor
"workflow": minor
"@workflow/cli": minor
---

Add an optional `purgeMany` method to the World interface, allowing deletion of stored data of finished runs on demand. Exposed as `run.purge()` (`workflow/api`), `purgeRun()` and `purgeRuns()` (`@workflow/core/runtime`), and `workflow purge <run-id>...` in CLI.
