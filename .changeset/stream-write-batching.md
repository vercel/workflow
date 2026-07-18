---
"@workflow/core": patch
---

Restore batched stream writes: `write()` on the server writable now resolves when a chunk is accepted into the client buffer (bounded by `WORKFLOW_STREAM_MAX_BUFFERED_BYTES`, default 1MB) instead of blocking until its flush reaches the server, so chunks written while a flush RPC is in flight form the next `writeMulti` batch. The step-completion barrier is preserved: `flushablePipe` holds each pending op until the sink's drain barrier reports the chunk server-acked, and `close()` drains before issuing the close RPC.
