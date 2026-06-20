---
'workflow': minor
'@workflow/core': minor
---

Add `ensureWorldStarted()` (exported from `workflow/runtime`) which starts the World once per process at server startup, running boot-time recovery of in-flight runs for self-hosted worlds. Call it from your framework's startup hook (e.g. a Next.js `instrumentation.ts`).
