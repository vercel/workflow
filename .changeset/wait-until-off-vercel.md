---
"@workflow/core": patch
---
Skip loading `@vercel/functions` for `waitUntil` outside Vercel, where it has no request context to extend. A local or self-hosted process's first `start()` no longer evaluates the whole module.
