---
'@workflow/core': patch
---

Keep the inline event-log delta fast path active with open hooks when `WORKFLOW_PRECONDITION_GUARD=1`, and keep turbo's forced optimistic inline start active after a hook or wait is created when `WORKFLOW_SEQUENTIAL_REPLAYS=1`.
