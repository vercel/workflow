---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-local": patch
"@workflow/vitest": patch
---

On spec 9 runs, add `WORKFLOW_RUN_AHEAD_DEPTH` to run inline steps ahead of their writes, and let `run.wakeUp()` complete sleeps from the run's orchestrator.
