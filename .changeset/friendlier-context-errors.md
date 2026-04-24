---
"@workflow/core": patch
"@workflow/errors": patch
---

Add structured context-violation error classes (`NotInWorkflowContextError`, `NotInStepContextError`, `NotInWorkflowOrStepContextError`, `UnavailableInWorkflowContextError`) with docs links and terminal-friendly framing, applied to twelve user-facing context-violation sites in `@workflow/core`.
