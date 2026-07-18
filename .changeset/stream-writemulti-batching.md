---
'@workflow/core': patch
---

Fix stream writes never batching: `flushablePipe` awaited each `writer.write()` and the WritableStream sink serialized chunks one at a time, so the server writable's buffer never held more than one chunk and its `writeMulti` batching path never engaged — every chunk became its own server round trip. The server writable now exposes a durable batch write that `flushablePipe` uses to coalesce chunks arriving while a previous write is in flight into a single `writeMulti`, while preserving the existing durability guarantees.
