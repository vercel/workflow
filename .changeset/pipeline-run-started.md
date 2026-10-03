---
'@workflow/world-vercel': patch
---

The eventsync owner writer pipelines `run_started` with the first step's `step_created`/`step_started` behind a single flush-through barrier instead of waiting for its acknowledgement first.
