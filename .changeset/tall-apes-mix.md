---
"@workflow/core": patch
---

otel: do not treat WorkflowSuspension errors as errors in the trace, as they symbolize effects and not actual exceptions.
