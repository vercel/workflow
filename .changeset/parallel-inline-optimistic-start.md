---
'workflow': minor
'@workflow/core': minor
---

Inline execution now runs up to `WORKFLOW_MAX_INLINE_STEPS` (default 3) steps in parallel per suspension, each lazily created. An opt-in `WORKFLOW_OPTIMISTIC_INLINE_START` (default off) additionally starts step bodies before `step_started` is confirmed, reconciling the in-flight start before the terminal write so a lost create-claim is discarded; it is off by default because under contention a step body can run more than once (e.g. two runs writing to the workflow stream can corrupt it), so only enable it for idempotent steps.
