---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-vercel': minor
'@workflow/world-local': minor
'@workflow/web-shared': patch
'@workflow/world-postgres': patch
---

Lazy hook resumption: `resumeHook()` writes the `hook_received` event and publishes the workflow invocation concurrently when both the consumer and backend independently attest dedup support, using a stable `resumeId` + payload digest so the direct write and the queue re-ensure converge on exactly one event. Otherwise it falls back to the sequential path; force it with `WORKFLOW_DISABLE_LAZY_HOOK_RESUME=1`.
