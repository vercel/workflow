---
'@workflow/world-postgres': patch
---

Throw `EntityConflictError` when a `run_created` event targets a run that already exists, instead of resolving with no run. This matches `world-local` and `world-vercel`, and stops `start()` from throwing `Missing 'run' in server response for 'run_created' event` when the resilient start path wins the race.
