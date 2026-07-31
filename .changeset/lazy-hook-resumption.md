---
"workflow": minor
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/web-shared": patch
"@workflow/world-postgres": patch
---

Lazy hook resumption: `resumeHook()` writes the `hook_received` event and publishes the workflow invocation concurrently — instead of sequentially — when both the target run's consumer and the live backend independently attest dedup support. Both writers carry a stable client-minted `resumeId` plus a payload digest, and the backend's `(runId, resumeId)` constraint collapses the direct write and the queue consumer's re-ensure onto exactly one event. When either attestation is absent (or the payload is too large to inline on the queue message), it falls back to the original sequential path; the fast path can also be disabled with `WORKFLOW_DISABLE_LAZY_HOOK_RESUME=1`. `resumeHook()` continues to return `Promise<Hook>`.
