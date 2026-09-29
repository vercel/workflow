---
'@workflow/world-vercel': patch
---

Ask the server to leave the step entity out of `step_completed`, `step_failed` and `step_retrying` responses (`omitStepEntity`), whose `step` the runtime never reads. A supporting server then does its post-commit step readback after responding instead of before; older servers ignore the field.
