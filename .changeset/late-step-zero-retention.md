---
"@workflow/world-local": patch
---

Scrub the result of a step that finishes after its `experimental_retention: 0` run has ended, so the late `step_completed`, `step_failed` or `step_retrying` payload is not left behind
