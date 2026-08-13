---
'@workflow/core': patch
---

Ignore a `step_started` or `step_retrying` written behind a step's recorded result instead of failing the run with `CORRUPTED_EVENT_LOG`. A losing attempt that outlives the winning one produces exactly that log, and neither writer was wrong.
