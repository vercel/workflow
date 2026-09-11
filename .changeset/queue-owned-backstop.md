---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Arm a delayed backstop wake instead of re-enqueueing a step that a queue delivery is already running (bare `step_started`, no terminal event) on Worlds that declare the new `capabilities.queueRedeliversUnacked`, which `@workflow/world-vercel` now does. `WORKFLOW_QUEUE_OWNED_BACKSTOP=0` restores the immediate re-enqueue.
