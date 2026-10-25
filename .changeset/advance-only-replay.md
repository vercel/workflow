---
"@workflow/core": patch
---

Let branches of `Promise.all` and `Promise.race` start their next steps without waiting for slow siblings, including when a step needs a delayed retry. An advance-only replay keeps completion and failure behind steps that are actually started or scheduled, while each replay derives which un-awaited terminal-drain creations were never sent.

While this feature is enabled, a run stays running until every started step settles, even when a step lost a `Promise.race` or was called without `await`. Previously those shapes could mark the run complete while the losing or fire-and-forget step was still running. A step called without `await` after a branch step may also now start where the previous lockstep replay skipped it. Set `WORKFLOW_ADVANCE_ONLY_REPLAY=0` to restore the previous behavior.

A one-shot safety probe, delayed by the inline-ownership lease, protects terminal progress without polling live work. The Node.js VM defaults to three pending siblings, and `WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING` can widen the bound.
