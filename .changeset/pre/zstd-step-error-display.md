---
'@workflow/world-vercel': patch
'@workflow/web-shared': patch
'@workflow/web': patch
---

Decompress gzip- and zstd-prefixed serialized data returned from Vercel Workflow storage, and route OSS web hydration through the async WASM-capable path for compressed payloads.
