---
'@workflow/world-vercel': patch
'@workflow/world-local': patch
---

Hold process-wide state (the WebSocket transport registry, HTTP connection pools, ULID factories, caches, log-once latches) on `globalThis` instead of at module scope. Both packages are bundled into the host server build, which gives one copy per bundler layer. The events WebSocket transport was registered in one copy and looked up in another, silently falling back to HTTP.
