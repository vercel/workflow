---
"@workflow/world-postgres": minor
---

Recover a spec 9 run whose worker died mid-delivery within about 8 minutes by default, instead of after Graphile Worker's 4 hours. With `jobLockStaleSeconds` unset, every delivery now renews its job lock and registers its worker as renewing, and another process releases a job in a spec 9 run's named queue once its lock has gone unrenewed for 300 seconds, if its holder registered. Jobs held by processes on earlier versions are never released this way, so the default is safe during a rolling upgrade. Setting `jobLockStaleSeconds` keeps releasing every job after that window, and `0` turns renewal off. Run `bootstrap` to apply migration `0030_add_job_lock_holders`; without it nothing is released, and a warning names the migration.
