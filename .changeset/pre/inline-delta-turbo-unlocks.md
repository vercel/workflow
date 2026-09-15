---
'@workflow/core': patch
---

Keep the inline event-log delta fast path active with open hooks when `WORKFLOW_PRECONDITION_GUARD=1` and the World declares `capabilities.preconditionGuard`. The lazy inline `step_started` claim now carries the guard snapshot so a stale replay's claim is fenced (412 → fresh replay), and guard-enforced batches with an open hook take the await-then-run path so a fenced claim never executes the step body.
