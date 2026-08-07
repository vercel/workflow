---
'@workflow/core': patch
---

Replays no longer fail with `CORRUPTED_EVENT_LOG` when an event that arrives from outside the replay, such as a hook delivery or a step completion, lands ahead of an event the replay wrote: those are held for whichever part of the workflow awaits them. Correlation IDs are also now drawn per entity kind by default, so a replay that disagrees about one `sleep()` no longer renames every step after it; runs started before this keep replaying under the scheme that minted their IDs.
