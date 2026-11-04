---
'@workflow/core': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
---

Enable `start({ hook })` by default on the Postgres and Vercel Worlds. `WORKFLOW_POSTGRES_EXPERIMENTAL_START_HOOK` and `WORKFLOW_VERCEL_EXPERIMENTAL_START_HOOK` are removed, along with the `EXPERIMENTAL_START_HOOK_ENV` exports; the capability is only used when a caller passes `hook` to `start()`.
