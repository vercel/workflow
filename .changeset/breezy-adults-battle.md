---
"@workflow/web": patch
"@workflow/cli": patch
---

Migrate `@workflow/web` from Next.js to React Router v7 framework mode. Replace child process spawning in the CLI with in-process Express server. Switch RPC transport from JSON to CBOR.
