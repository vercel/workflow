---
'@workflow/world-local': patch
---

A delivery waiting out a `{ timeoutSeconds }` wake or a retry backoff no longer holds one of the `WORKFLOW_LOCAL_QUEUE_CONCURRENCY` slots, so other messages run while it waits. A wake with a delay also no longer spends the queue's 256-iteration safety limit, which used to drop a message after 256 wakes.
