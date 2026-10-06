---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-local": patch
"@workflow/vitest": patch
---

Inline steps run ahead of their writes when no other writer can change the workflow's path (`WORKFLOW_RUN_AHEAD_DEPTH`), and `run.wakeUp()` lets the run's orchestrator complete the sleeps.
