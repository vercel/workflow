---
'@workflow/world-vercel': patch
'@workflow/world-local': patch
---

Hold process-wide state (the WebSocket transport registry, HTTP connection pools, ULID factories, caches, log-once latches) on `globalThis` instead of at module scope. This de-duplicates state across bundled packages. Fixes WebSocket transport, which was registered in one module state but looked up in another.
