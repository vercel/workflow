---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Experimental and off by default: with `WORKFLOW_INLINE_SKIP_RUN_CREATED=1`, a `start()` whose first orchestrator message is held for the calling process writes no `run_created`. The inline delivery's `run_started` creates the run, and `start()` returns once it has. A message that isn't held gets `run_created` as before. Needs the new `capabilities.runStartedCreatesRun`, which World Vercel declares. With the flag, a creating `run_started` asks the World to record it as the run's creation (`CreateEventParams.createsRun`).
