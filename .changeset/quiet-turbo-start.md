---
"@workflow/core": patch
---

Hold a turbo step's awaited `step_started` until the backgrounded `run_started` lands, so an explicit `WORKFLOW_OPTIMISTIC_INLINE_START=0` no longer gets its first step rejected for a run that has not started yet.
