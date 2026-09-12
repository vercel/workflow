---
"@workflow/core": minor
---

Resilient step dispatch is on by default (`WORKFLOW_RESILIENT_STEP_DISPATCH=0` disables it) and composes with the batched fan-out fold: a fan-out's step messages are published, carrying their input, before their `step_created` events commit, and a queued step whose create has not landed is materialized by one lazy `step_started` instead of a `step_created` write and a second bare start. A queued step whose bare `step_started` is refused with a conflict while the step is still pending has the start retried, then the delivery fails for redelivery, instead of being acknowledged as skipped.
