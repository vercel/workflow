---
'@workflow/core': patch
---

Allow a host to install pre-compiled QuickJS WASM modules via `setQuickJSAssets`, so the QuickJS VM engine can run on runtimes that forbid compiling WebAssembly from bytes (e.g. Cloudflare Workers).
