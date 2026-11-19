---
"@workflow/world-postgres": patch
---

Add `skipWorkers` (`WORKFLOW_POSTGRES_SKIP_WORKERS=1`): a process that starts the World without running workers. It can still start runs, resume hooks, cancel runs and read them, while processes with workers against the same database and `jobPrefix` execute and recover them.
