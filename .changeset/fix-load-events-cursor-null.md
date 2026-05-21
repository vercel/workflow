---
"@workflow/core": patch
"workflow": patch
---

Fix spurious "Event cursor missing after initial load" warning and the redundant full-event reload it caused. `loadWorkflowRunEvents` now preserves the last non-null cursor across pages so a trailing empty page from the World (e.g. when DynamoDB returns `LastEvaluatedKey` at a page boundary) no longer clobbers it.
