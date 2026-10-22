---
"@workflow/core": patch
---

Let each branch of a two-branch `Promise.all` or `Promise.race` start its next step without waiting for its sibling. Both steps retain the existing inline execution path, and an early settler hands off a bounded advance-only replay; detached steps and race losers still finish before the run becomes terminal. The Node.js VM defaults to one pending sibling, `WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING` can widen the bound, and `WORKFLOW_ADVANCE_ONLY_REPLAY=0` restores the old lockstep behavior.
