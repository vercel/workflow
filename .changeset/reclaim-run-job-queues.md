---
"@workflow/world-postgres": patch
---

Reclaim the per-run Graphile named queue a spec 9 (or invoke) run leaves behind. `graphile_worker._private_job_queues` grew one row per run forever, including for runs that had finished or whose row was already gone. A periodic sweep deletes the empty, unlocked queues of runs that are gone or have been terminal for five minutes, fenced by an `EXCLUSIVE` lock on the queue table so a send in flight cannot end up with a job whose queue no longer exists. Queues of other applications sharing the schema, and of active runs, are left alone.
