---
'@workflow/next': patch
---

Stop eager input-graph directive discovery in deferred Next.js builds and rely on loader/socket-driven discovery with `onBeforeDeferredEntries`.
