---
"@workflow/core": minor
---

Resilient step dispatch (`WORKFLOW_RESILIENT_STEP_DISPATCH=1`, still opt-in) now composes with the batched fan-out fold instead of excluding it: with it enabled, a fan-out's step messages are published in one batch, carrying their input, before their `step_created` events commit. A queued step whose create has not landed is materialized by one lazy `step_started` instead of a `step_created` write and a second bare start, and the eager re-ensure on redelivery is gone. A queued step whose bare `step_started` is refused with a conflict is now arbitrated against the step entity: a running or finished step acknowledges the delivery as the loser, and a step that is still pending has the start retried and then fails the delivery for redelivery, instead of being acknowledged as skipped.
