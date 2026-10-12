---
'@workflow/core': patch
---

Compress workflow arguments on the libuv threadpool when starting a run, so large inputs no longer block the caller's event loop during zstd compression.
