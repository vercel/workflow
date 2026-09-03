---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-sim': patch
---

Settle a hook's awaiter in the invocation that created the hook instead of re-invoking through the queue. The hook-create write now asks for the event-log delta since the replay's cursor (`CreateEventParams.sinceCursor`), and the runtime resumes the retained VM over the returned event — removing a delivery round-trip and a cold replay per awaited hook. This covers both outcomes of the create: the `hook_created` a `hook.getConflict()` is parked on, and the `hook_conflict` a create whose token is already claimed commits instead, which settles the same awaiter (rejecting a payload await, resolving `getConflict()` with the conflicting run) and no longer costs a re-invocation. Worlds that return no delta fall back to an incremental read, and `WORKFLOW_RETAINED_VM=0` restores the re-invocation.
