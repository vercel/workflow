---
"@workflow/core": patch
---

Log at info, not error, when a run cancelled during a delivery refuses the delivery's next step, and acknowledge the delivery instead of trying to fail the run.
