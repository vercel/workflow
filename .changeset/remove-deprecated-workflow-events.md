---
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/web-shared": patch
---

Remove deprecated `workflow_completed`, `workflow_failed`, and `workflow_started` events in favor of `run_completed`, `run_failed`, and `run_started` events.
