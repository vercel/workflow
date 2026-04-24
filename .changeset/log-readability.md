---
"@workflow/core": patch
"@workflow/utils": patch
---

Render step-level and workflow-level fatal-error logs with the stack trace inline in the message (matching the workflow-level framing), rather than as a string-encoded `errorStack` field inside the metadata object. Log drains still get compact, indexable structured fields (`errorAttribution`, `errorName`, `errorMessage`, `hint`, IDs); humans reading the terminal now see the stack natively. Also adds `formatStepName` / `formatWorkflowName` helpers in `@workflow/utils` and uses them to render framings as `add (./workflows/1_simple)` instead of `"step//./workflows/1_simple//add"` everywhere we log user-facing step and workflow names.
