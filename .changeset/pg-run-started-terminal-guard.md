---
"@workflow/world-postgres": patch
---

A `run_started` that races the run ending no longer moves the run back to `running`; it's refused with `RunExpiredError`.
