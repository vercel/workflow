---
"@workflow/world-postgres": minor
---

Add `world.pauseClaims()` and `world.resumeClaims()`. A paused world stops claiming queue jobs without closing: Graphile Worker's runner stops gracefully, so jobs already running finish, while enqueueing, streams and storage keep working, and neither `start()` nor `queue()` brings a runner back until `resumeClaims()`. Resuming starts only the runner and does not repeat the active-run recovery that `start()` performs. This lets a process that shares a database with other deployments step out of claiming — for example a blue-green revision that no longer receives traffic but is still draining — instead of claiming jobs it should not run.
