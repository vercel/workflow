---
"@workflow/core": patch
---

Run steps started beside an awaited `hook.getConflict()` inline instead of handing them to the queue: the suspension now defers their creates, settles the awaiter off the hook write, and runs the bodies on the pass after it.
