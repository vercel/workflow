---
"@workflow/world-vercel": patch
---

Build the optional `@opentelemetry/api` import specifier at runtime so bundlers (Rollup/Vite/Turbopack) don't statically resolve it and fail the build when the peer isn't installed. Runtime semantics are unchanged.
