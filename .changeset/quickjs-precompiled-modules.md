---
"@workflow/core": patch
---

Add `setPrecompiledQuickJSModules()` to `@workflow/core/runtime`, so a host whose runtime forbids compiling WebAssembly from bytes (Cloudflare Workers) can hand the QuickJS engine modules compiled at deploy time.
