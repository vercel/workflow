---
'@workflow/world': patch
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Report the events a replay diverged at (`replayDivergenceEventIds`, ids only) beside `replayDivergenceCount` on the write that ends a divergence episode, including the `run_failed` of a `CORRUPTED_EVENT_LOG` failure, so world-vercel can locate the divergence when the run's error payload is encrypted.
