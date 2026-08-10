---
'@workflow/world-vercel': patch
'@workflow/core': patch
'@workflow/world': patch
---

Event IDs are now a dense per-run slot number. A replay tells the world how many events it had read and gets back the ones it did not see, so an event that arrives from outside the replay, such as a hook delivery or a step completion, landing ahead of an event the replay wrote no longer fails the run with `CORRUPTED_EVENT_LOG`: it is held for whichever part of the workflow awaits it, and reported on the span (`workflow.events.parked.count`, `.event_id`, `.event_type`) if a replay suspends still holding it. A gap in the numbering fails the run instead of being replayed over. On the Vercel world this arrives as spec version 6; runs created before it keep their existing event IDs, and a World may now declare a spec version above the runtime default.
