---
'@workflow/world-vercel': patch
---

Make HTTP/2 resilient to bundling: install a global `require` so undici can load `node:http2` in ESM server bundles, and fall back to HTTP/1.1 (with a one-time warning) instead of hanging when it can't.
