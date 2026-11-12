---
'@workflow/world-postgres': patch
---

Stop startup recovery from replaying runs parked on a hook or a wait that is not yet due, and key each run's recovery job by the run, so repeated boots replace a queued recovery job instead of adding another. A run is still recovered when a wake was stored but its job never queued: migration `0031_add_run_wake_pending` adds `workflow_runs.wake_pending`, set with each event that wakes a run and cleared when an orchestrator delivery completes. Runs that exist before the migration start with it set, so the first boot after upgrading recovers them as before. Run `bootstrap` before deploying.
