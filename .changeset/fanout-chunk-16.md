---
"@workflow/core": patch
---

Start the queued branches of a wide `Promise.all` fan-out sooner. The batched fan-out now commits its writes in `createBatch` calls of at most 16 events instead of 32. Each queued branch's message waits on its chunk's commit and then its chunk's batched publish, and both are faster for smaller chunks. In production sweeps, the last branch of a 64-branch fan-out started about 90 ms sooner at p50, and of a 128-branch fan-out about 200 ms sooner, with no change to the first branch at those widths.
