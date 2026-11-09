---
'workflow': minor
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-vercel': minor
---

Start a workflow straight from a Vercel Schedule. `scheduleTopic(workflow)` from `workflow/api` is the Vercel Queues topic to set as a schedule's target, and `scheduleTarget(workflow, payload)` spreads into `Schedules.create()` with the payload type-checked against the workflow's `ScheduledRun<Payload>` parameter. The flow route receives the schedule's message on that topic and starts the workflow with the occurrence, keyed by its `executionId` so a redelivery never starts a second run. No route or queue consumer of the app's sits in between.
