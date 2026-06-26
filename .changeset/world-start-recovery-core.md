---
'workflow': minor
'@workflow/core': minor
---

Add `ensureWorldStarted()` (exported from `workflow/runtime`) which starts the World once per process at server startup, running boot-time recovery of in-flight runs for self-hosted worlds. Call it from your framework's startup hook (e.g. a Next.js `instrumentation.ts`). In production it recovers (re-enqueues) in-flight runs; in development it cancels them instead (their workflow code has likely changed, so replaying would diverge). Pass `{ dev }` from your framework's dev flag, or rely on the `NODE_ENV` fallback; set `WORKFLOW_RECOVER_IN_DEV=1` to force recovery in dev.
