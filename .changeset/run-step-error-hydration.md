---
"@workflow/core": major
"@workflow/errors": major
"@workflow/world": major
"@workflow/world-local": major
"@workflow/world-postgres": major
"@workflow/world-vercel": major
---

**BREAKING CHANGE**: Serialize thrown values through the workflow serialization pipeline for `step_failed`, `step_retrying`, and `run_failed` events.

- `WorkflowRun.error` and `Step.error` are now `SerializedData` (Uint8Array) instead of `{ message, stack?, code? }`. Consumers that previously read these fields directly must hydrate via `hydrateRunError` / `hydrateStepError`.
- `WorkflowRun` gains a top-level `errorCode` field carrying the previous `error.code` value as plaintext metadata.
- `WorkflowRunFailedError.cause` is now `unknown` (the hydrated thrown value with its original type identity, cause chain, and custom properties preserved) instead of a synthesized `Error`. A new `errorCode` property exposes the error classification.
- Event payload for `step_failed`, `step_retrying`, and `run_failed` now contains `error: SerializedData` (was `{ message, stack? }` / `{ message, stack?, code? }`).
- `@workflow/world-postgres` gains a new migration (`0010_add_error_code.sql`) adding an `error_code` column to `workflow.workflow_runs`. Legacy records in the deprecated `error` text column are surfaced as `undefined` on read (they cannot be hydrated into the original thrown value).
