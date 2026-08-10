---
'@workflow/core': patch
---

A replay that suspends while still holding an out-of-band event no consumer claimed now records it on the span (`workflow.events.parked.count`, `.event_id`, `.event_type`), so a run that keeps stopping on the same undelivered event is visible instead of only surfacing if it ends.
