---
"@workflow/errors": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
"workflow": patch
---

Add `InBandSupersededError` and optional `inBand`/`expectedSeqInBand` event-create params for the in-band writer fence. `@workflow/world-vercel` forwards them, does not retry a fenced write in-process, and records the fence on its event spans. The runtime does not use them yet.
