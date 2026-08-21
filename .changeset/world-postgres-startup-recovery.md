---
'@workflow/world-postgres': patch
---

Skip parked runs during startup recovery and enqueue recovery jobs with a stable job key so repeated boots do not accumulate duplicate jobs.
