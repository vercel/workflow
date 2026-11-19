---
"@workflow/core": patch
---
A `start({ experimental_hook })` candidate's first spec 9 delivery no longer reads the event log after its `run_started`: the write's skipped-slot report brings whatever landed after the run's creation, so the log stays whole. A report that stops short or leaves a hole still gets the load.
