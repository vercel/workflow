---
"@workflow/core": minor
---

Carry an object-stream write larger than the transport's 10 MiB per-chunk cap across several chunks instead of failing it, reassembling it in the reader. Gated on the target run's `splitStreamChunks` capability so older readers keep the previous behaviour; `WORKFLOW_STREAM_SPLIT_CHUNKS=0` disables it.
