---
"@workflow/world": minor
"@workflow/world-vercel": minor
"@workflow/core": minor
"workflow": minor
"@workflow/cli": minor
---

Delete the stored data of finished runs on demand, the same data a run started with `experimental_retention: 0` has deleted when it ends. Worlds may implement the optional `runs.purgeMany({ runIds })`, and world-vercel does. `run.purge()` (`workflow/api`), `purgeRun()` and `purgeRuns()` (`@workflow/core/runtime`), and `workflow purge <run-id>...` call it. Only finished runs are purged; a run that hasn't finished is answered `skipped` and keeps running. There is no fallback: they throw, or the CLI exits with an error, on a World that doesn't support purging.
