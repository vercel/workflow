---
'workflow': minor
'@workflow/core': minor
---

Inline execution now runs up to `WORKFLOW_MAX_INLINE_STEPS` (default 3) steps in parallel per suspension (each lazily created), and starts step bodies optimistically before `step_started` is confirmed (`WORKFLOW_OPTIMISTIC_INLINE_START`, default on) — reconciling the in-flight start before the terminal write so a lost create-claim is discarded. Optimistic bodies may run more than once under contention, so inline steps must be idempotent; disable with `WORKFLOW_OPTIMISTIC_INLINE_START=0`.
