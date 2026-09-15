---
'@workflow/world': patch
'@workflow/core': patch
---

Require every event id the runtime reads to be a log position. `requireEventSlot` replaces the lenient decode that returned "no position" for an id that is not a slot.
