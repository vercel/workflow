---
"@workflow/core": patch
---

Let branches in a `Promise.all` or `Promise.race` start their next steps without waiting for slower siblings, including retries and nested parallel steps. An advance-only replay keeps completion and failure behind steps that are actually started or scheduled, while each replay derives which un-awaited terminal-drain creations were never sent. A one-shot safety probe, delayed by the inline-ownership lease, protects terminal progress without polling live work. The Node.js VM defaults to three pending siblings, carries a conservative eligibility hint through wider chained fan-outs, and supports `WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING` to widen the bound. `WORKFLOW_ADVANCE_ONLY_REPLAY=0` restores the old lockstep behavior.
