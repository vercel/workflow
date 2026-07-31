---
"workflow": minor
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/web-shared": patch
"@workflow/world-postgres": patch
---

Lazy hook resumption: on a fast path, `resumeHook()` writes the `hook_received` event and dispatches the workflow queue message concurrently instead of sequentially, cutting a round trip off resume latency. A `(runId, resumeId)` dedup constraint keeps the two writers converging on exactly one event; the runtime falls back to the sequential path when dedup support is unavailable or when `WORKFLOW_DISABLE_LAZY_HOOK_RESUME=1`. `resumeHook()` resolves to a `ResumedHook` (a `Hook` plus an optional `resilientResume: true` flag, set only when the direct write failed transiently and the resume was recovered via the queue consumer's re-ensure) — preserving the contract introduced alongside the resilient-resume work.
