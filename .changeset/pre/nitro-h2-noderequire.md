---
'@workflow/nitro': patch
---

Fix HTTP/2 requests failing in production builds (Vite/Nitro, TanStack Start) where undici's bundled `node:http2` could not load and fell back to a stub.
