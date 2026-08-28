---
'@workflow/core': minor
'@workflow/world': minor
---

Add a `retention` option to `start()` for requesting deletion of run data on completion. `retention: 0` asks the World to delete the run's user data — event payloads and stream chunks — as soon as the run completes or fails; `'default'` is identical to omitting the option and leaves the decision to the World. It is recorded as the reserved `$retention` run attribute, so it needs a World implementing spec version 4 or later.

The value is a duration, and zero is the only one implemented: the unit durations will be measured in has not been decided yet, and zero is the one value that means the same thing whichever unit wins, so it can ship ahead of that decision. The option is typed as the literal `0` rather than `number` so that a duration nothing can honor yet is rejected instead of silently resolving to the World's default.
