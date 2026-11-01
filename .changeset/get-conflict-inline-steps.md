---
"@workflow/core": patch
---

Run steps started beside an awaited `hook.getConflict()` inline instead of handing them to the queue: the suspension now defers their creates, settles the awaiter off the hook write, and runs the bodies on the pass after it. Those steps now share one inline batch with whatever the settled awaiter started, so work the awaiter's branch begins after its own first step waits for them — where queueing put the branch in a separate invocation. Steps past `WORKFLOW_MAX_INLINE_STEPS` are unaffected and still queue.
