---
"@workflow/nitro": patch
---

Check `globalThis.require` in the server-chunk `createRequire` banner, so a chunk that declares its own `require` binding (an inlined `@vercel/otel`, for example) loads instead of failing with `ReferenceError: Cannot access 'require' before initialization` at server startup.
