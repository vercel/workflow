---
"@workflow/world-postgres": minor
---

Scope startup recovery to the World's `jobPrefix`: `start()` re-enqueues only the active runs created under its own prefix (plus unprefixed runs from earlier versions), so apps that share a database no longer drive each other's runs after a restart. A migration adds `workflow_runs.job_prefix`; run `bootstrap` before deploying.
