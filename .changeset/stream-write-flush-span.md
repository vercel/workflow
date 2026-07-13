---
'@workflow/core': patch
---

Emit a client-observed `workflow.stream.write` span per flushed stream-write batch, with a `buffer_dwell_ms` attribute separating client-side batching cost from network/server time
