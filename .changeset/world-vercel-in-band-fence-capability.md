---
"@workflow/world-vercel": patch
"@workflow/world": patch
"@workflow/world-testing": patch
---

`@workflow/world-vercel` declares the `inBandFence` capability (its backend refuses a stale in-band write on every run with an event sequencer, and answers an in-band write on an older run with a 400), and passes on the in-band counts its backend reports: `snapshot` on `events.list` and `allocated` on a single `events.create`. The `inBandFence` contract lets a World list no snapshot when its refusals carry both counters, and `@workflow/world-testing` takes the counters from a refusal for such a World.
