---
"@workflow/core": patch
---

Let each branch of a two-branch `Promise.all` start its next step without waiting for its sibling (`WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING` can widen the bound and `WORKFLOW_ADVANCE_ONLY_REPLAY=0` restores the old behavior).
