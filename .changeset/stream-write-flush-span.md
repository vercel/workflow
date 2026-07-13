---
'@workflow/core': patch
---

Emit a client-observed `workflow.stream.write` span per flushed stream-write batch, back-dated to the batch's first `write()` — its duration covers buffer dwell + RPC, with `workflow.stream.write.buffer_dwell_ms`/`chunks`/`bytes` attributes separating client-side batching cost from network/server time
