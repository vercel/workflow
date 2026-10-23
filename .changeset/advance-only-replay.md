---
"@workflow/core": patch
---

Let each branch of a two-branch `Promise.all` or `Promise.race` start its next step without waiting for its sibling. An advance-only replay keeps completion and failure behind steps that are actually started or scheduled, while each replay derives which un-awaited terminal-drain creations were never sent. A one-shot safety probe, delayed by the inline-ownership lease, protects terminal progress without polling live work. The Node.js VM defaults to one pending sibling, `WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING` can widen the bound, and `WORKFLOW_ADVANCE_ONLY_REPLAY=0` restores the old lockstep behavior.
