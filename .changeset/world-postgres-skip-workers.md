---
"@workflow/world-postgres": patch
---

Add `skipWorkers` (`WORKFLOW_POSTGRES_SKIP_WORKERS=1`): a process that starts the World without running workers. It can still start runs, resume hooks, cancel runs and read them. Processes with workers on the same database, `jobPrefix` and `deploymentId` (when one is set) execute those runs, and recover the ones it didn't enqueue the next time they start.
