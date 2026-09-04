---
"@workflow/core": patch
---

Stream write batching now lives in the server writable itself (group commit), so raw `ReadableStream`s piped across workflow/step boundaries batch the same as `getWritable()` instead of sending one request per chunk.
