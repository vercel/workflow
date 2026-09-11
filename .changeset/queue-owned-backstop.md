---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Stop re-enqueueing steps that a queue delivery is already running (bare `step_started`, no terminal event) on Worlds that declare the new `capabilities.queueRedeliversUnacked`, which `@workflow/world-vercel` now does; each replay pass arms one delayed backstop wake for the run instead. `WORKFLOW_QUEUE_OWNED_BACKSTOP=0` restores the immediate re-enqueue.
