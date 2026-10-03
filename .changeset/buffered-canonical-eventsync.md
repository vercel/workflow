---
'@workflow/world-vercel': patch
'@workflow/world': patch
'@workflow/core': patch
---

Pipeline canonical eventsync writes through an owner-private outbox. Hook input and new-step create/start events are transmitted without per-event durability waits; flush confirms the complete prefix against native acknowledgements before step execution or input acceptance. Preserve standard event clocks, native materializations and all read APIs.
