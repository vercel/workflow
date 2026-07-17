---
'@workflow/core': patch
---

Keep the inline event-log delta fast path active with open hooks when `WORKFLOW_PRECONDITION_GUARD=1` and the World declares `capabilities.preconditionGuard`, guarding the lazy inline `step_started` claim with the snapshot so a stale replay's claim is fenced (412 → fresh replay). Keep turbo's forced optimistic inline start active after a hook or wait is created when `WORKFLOW_SEQUENTIAL_REPLAYS=1` and the World declares `capabilities.maxConcurrency`.
