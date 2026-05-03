---
"@workflow/core": patch
"@workflow/errors": patch
"@workflow/builders": patch
"@workflow/utils": patch
---

Friendlier workflow error messages. New `SerializationError`, `WorkflowBuildError`, and structured context-violation classes (e.g. `NotInWorkflowContextError`) with actionable hints and docs links applied to user-facing throw sites; `FatalError.is()` recognizes any error with `fatal: true` so context violations and serialization failures now fail fast instead of burning retry attempts. Runtime logs are namespaced under `[workflow-sdk]` and gain `errorAttribution` (`user` vs `sdk`) plus class-aware hints; `Ansi` helpers moved to a new `@workflow/errors/ansi` subpath so consumers that only use the error classes don't pull `chalk` into their bundle. Adds a `@workflow/core/describe-error` subpath so CLI / web observability renderers can derive the same user-vs-SDK framing from persisted failure events.
