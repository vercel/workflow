---
"@workflow/world-postgres": minor
---

Scope startup recovery to the World's `jobPrefix`. `start()` now re-enqueues only the active runs created under its own prefix, plus runs created before this release, instead of every active run in the database, so apps that share a database no longer drive each other's runs after a restart. Migration `0026` adds `workflow_runs.job_prefix`; run `bootstrap` before deploying.
