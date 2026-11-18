---
"@workflow/world": minor
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/core": minor
"workflow": minor
"@workflow/cli": minor
---

Add an optional `runs.deleteDataMany` method to the World interface, which deletes the stored data (payloads, not metadata) of finished runs on demand, and implement it in the Vercel, Local and Postgres Worlds. Exposed as `run.delete()` and `deleteRuns()` (`workflow/api`), `deleteRuns(world, runIds)` (`@workflow/core/runtime`), and `pnpx workflow delete <runId>` in the CLI. `workflow cancel` and `workflow start` no longer accept listing flags they ignored, such as `--limit` on `start` or `--cursor` and `--sort` on either. `workflow delete`, `workflow cancel` and `workflow start` now print an error they fail with, such as an unknown flag, instead of exiting with no output.
