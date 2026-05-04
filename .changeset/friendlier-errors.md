---
"@workflow/core": patch
"@workflow/errors": patch
"@workflow/builders": patch
"@workflow/utils": patch
---

Friendlier workflow error messages. New `SerializationError`, `WorkflowBuildError`, and structured context-violation classes (e.g. `NotInWorkflowContextError`) with actionable hints and docs links applied to user-facing throw sites; `FatalError.is()` recognizes any error with `fatal: true` so context violations and serialization failures now fail fast instead of burning retry attempts. Runtime logs are namespaced under `[workflow-sdk]` and gain `errorAttribution` (`user` vs `sdk`) plus class-aware hints
