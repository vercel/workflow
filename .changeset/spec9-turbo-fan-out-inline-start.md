---
"@workflow/core": patch
---

Spec 9 turbo: on a run's first delivery, a fan-out (inline steps beside background steps) now starts its inline bodies while its creation batches commit, as a boundary of only inline steps already did. Background steps' messages still go out only once their creation committed. A 64-branch fan-out's first branch no longer waits for `run_started` and the 64-event creation batch (300 to 420 ms on world-vercel) before it starts.
