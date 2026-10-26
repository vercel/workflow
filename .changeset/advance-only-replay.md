---
"@workflow/core": patch
---

Let eligible branches of `Promise.all` and `Promise.race` start their next steps and delayed retries without waiting for slow siblings; a step called without `await` after a branch step may now start where the previous lockstep replay skipped it.
`Promise.race` can now resolve to the branch that truly settles first, where lockstep replay could previously let a slower step win.
Runs still complete or fail as soon as the workflow returns or throws, so race losers and un-awaited steps may settle afterward; set `WORKFLOW_ADVANCE_ONLY_REPLAY=0` to restore lockstep branch timing.
