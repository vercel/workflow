---
"@workflow/world": patch
"@workflow/core": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
---

Add `streamFlushIntervalMs` option to `Streamer` interface, optional for worlds to allow overwriting the default of 10ms in low-latency environments.
