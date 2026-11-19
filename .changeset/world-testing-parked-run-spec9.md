---
"@workflow/world-testing": patch
---

The queue auth tests' parked run now also waits for the workflow's first step to end, so a spec 9 run whose inline step has not written its `step_started` yet is no longer read as parked.
