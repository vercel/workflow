---
'@workflow/sveltekit': patch
'@workflow/nitro': patch
---

Remove the per-bundler HTTP/2 `require` build banner; `@workflow/world-vercel` now installs the shim itself (and falls back to HTTP/1.1 when `node:http2` is unreachable), so no integration-specific patch is needed.
