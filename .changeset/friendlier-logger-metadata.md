---
"@workflow/core": patch
---

Structured runtime logger now supports `.child()` / `.forRun(runId, workflowName)` to attach stable per-run metadata without repeating it, standardizes the console prefix to `[workflow-sdk]`, and surfaces error stacks in flattened log drains. Clarifies replay-timeout phrasing (warn while retrying vs. error when giving up).
