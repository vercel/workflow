---
"@workflow/core": major
"@workflow/errors": major
"@workflow/world": major
"@workflow/world-local": major
"@workflow/world-postgres": major
"@workflow/world-vercel": major
---

**BREAKING CHANGE**: `step_failed`, `step_retrying`, and `run_failed` events now serialize the full thrown value via the workflow serialization pipeline. `WorkflowRun.error` / `Step.error` are now `SerializedData` (hydrate via `hydrateRunError` / `hydrateStepError`), `WorkflowRun` gains a top-level `errorCode`, and `WorkflowRunFailedError.cause` is the hydrated thrown value (`unknown`) with its original class identity, cause chain, and custom properties preserved.
</content>
</invoke>