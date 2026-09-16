---
'@workflow/core': minor
'workflow': minor
---

Add `registerLifecycleHooks` (exported from `workflow/api`) for registering global `onRunCompleted`/`onRunFailed` handlers that receive the lazily-hydrated `Run` instance — and, for failures, a `WorkflowRunFailedError` with the hydrated cause and error code — enabling centralized reporting (e.g. to Sentry) from `instrumentation.ts`.
