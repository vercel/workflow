---
"@workflow/world-vercel": minor
"@workflow/world": patch
---

`@workflow/world-vercel` declares the `inBandFence` capability (its backend refuses a stale in-band write on every run with an event sequencer), and passes on the in-band counts its backend reports: `snapshot` on `events.list` and `allocated` on `events.create`.
