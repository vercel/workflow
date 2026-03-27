---
"@workflow/world": patch
"@workflow/core": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
---

Add `streamFlushIntervalMs` option to `Streamer` interface, allowing non-Vercel world implementations to configure the stream write buffer flush interval. Defaults to 10ms (unchanged behavior). Set to 0 for immediate flushing on backends with sub-millisecond writes.
