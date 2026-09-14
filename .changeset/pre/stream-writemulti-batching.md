---
'@workflow/core': patch
---

Fix stream writes never batching: `flushablePipe` awaited each `writer.write()` and the WritableStream sink serialized chunks one at a time, so the server writable's buffer never held more than one chunk and its `writeMulti` batching path never engaged — every chunk became its own server round trip. The server writable now exposes a durable batch write that `flushablePipe` uses to coalesce chunks arriving while a previous write is in flight into a single `writeMulti`, while preserving the existing durability guarantees. Coalesced batches are split at chunk-count and byte wire limits (`WORKFLOW_STREAM_MAX_CHUNKS_PER_BATCH`, `WORKFLOW_STREAM_MAX_BYTES_PER_BATCH`), independent of the read-ahead backpressure bound (`WORKFLOW_STREAM_MAX_INFLIGHT_CHUNKS`).
