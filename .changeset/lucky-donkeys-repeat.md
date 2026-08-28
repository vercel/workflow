---
'@workflow/core': minor
'@workflow/world': minor
---

Add an `experimental_retention` option to `start()` for requesting deletion of run data on completion. `experimental_retention: 0` asks the World to delete the run's user data — workflow and step inputs, outputs and errors, event payloads, and stream contents — as soon as the run completes or fails; `'default'` is identical to omitting the option and leaves the decision to the World. It is recorded as the reserved `$retention` run attribute, so it needs a World implementing spec version 4 or later.

The value is a duration, and zero is the only one implemented: the unit durations will be measured in has not been decided yet, and zero is the one value that means the same thing whichever unit wins, so it can ship ahead of that decision. The option is typed as the literal `0` rather than `number` so that a duration nothing can honor yet is rejected instead of silently resolving to the World's default. The name carries an `experimental_` prefix for the same reason — both the unit and the accepted value set are expected to change.

Retention is enforced by the World, not the SDK. All three first-party Worlds implement it; a World that does not recognize the value keeps the data, which is the deliberate fallback — keeping data you meant to delete is recoverable, deleting data you meant to keep is not.

Known limitation at `0`: the deletion races the caller's own read of the run result and generally wins, so `await run.returnValue` on such a run usually resolves to an expired-data marker rather than the value. Return results through a channel you control instead.
