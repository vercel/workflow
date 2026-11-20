---
'@workflow/core': patch
'@workflow/world-vercel': patch
---

Send the writes of rate limit calls made at once in one batch, and declare `rateEventsInBatch` on world-vercel now that its backend decides rate events in a batch.
