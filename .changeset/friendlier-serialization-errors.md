---
"@workflow/core": patch
"@workflow/errors": patch
---

Add `SerializationError` (with optional `hint` + docs link) and apply it to all user-facing serialization boundaries (stream locking, unregistered classes, missing `WORKFLOW_DESERIALIZE`, and dehydrate/hydrate failures for workflow / step args and return values). Bare internal-invariant throws in the same paths now use `WorkflowRuntimeError` for consistent classification.
