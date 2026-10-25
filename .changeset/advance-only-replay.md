---
"@workflow/core": patch
---

Let branches of `Promise.all` and `Promise.race` start their next steps without waiting for slow siblings, including when a step needs a delayed retry. An advance-only replay keeps completion and failure behind steps that are actually started or scheduled, while each replay derives which un-awaited terminal-drain creations were never sent.

Runs that never use an advance-only branch replay keep the previous terminal behavior: a timeout can win `Promise.race` and return while its losing step finishes in the background, and a fire-and-forget step does not delay completion. Once a branch actually advances early, completion and failure wait for executable work started by that concurrent replay. A step called without `await` after a branch step may now start where the previous lockstep replay skipped it. Set `WORKFLOW_ADVANCE_ONLY_REPLAY=0` to restore the previous behavior for every shape.

A one-shot safety probe, delayed by the inline-ownership lease, protects terminal progress without polling live work. The Node.js VM defaults to three pending siblings, and `WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING` can widen the bound.
