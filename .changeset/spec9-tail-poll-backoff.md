---
"@workflow/core": patch
---

Back off a spec 9 orchestrator's log-tail poll while no live feed covers the run: each empty poll doubles the interval up to 10 seconds, reset on activity.
