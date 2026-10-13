---
"@workflow/core": patch
---

Order `setAttributes()` resolution with the replay delivery barriers so a branch awaiting it can no longer resume out of event-log order, which could fail the run with `REPLAY_DIVERGENCE` or hand concurrent branches each other's step results
