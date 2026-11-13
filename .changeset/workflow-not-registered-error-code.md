---
"@workflow/errors": patch
"@workflow/core": patch
---
Classify runs that fail with `WorkflowNotRegisteredError` under a dedicated `WORKFLOW_NOT_REGISTERED` error code instead of the generic `RUNTIME_ERROR`, so starting a workflow the deployment doesn't bundle is attributed separately from internal runtime failures.
