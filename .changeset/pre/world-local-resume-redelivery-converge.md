---
'@workflow/world-local': patch
---

Converge a redelivered `hook_received` re-ensure on its already-committed `(runId, resumeId)` claim instead of rejecting with `HookNotFoundError` when the hook was disposed after the resume was recorded. The rejection made the queue consumer ack the redelivery as "nothing left to resume", silently dropping any continuation the message carried.
