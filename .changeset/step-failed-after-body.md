---
"@workflow/world": patch
"@workflow/core": patch
---

Mark `step_failed` writes that record a failed step body with `afterStepBody`, so a World can keep waiting out a throttled write instead of re-running the body.
