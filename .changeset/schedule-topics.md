---
'workflow': minor
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-vercel': minor
'@workflow/swc-plugin': minor
'@workflow/builders': minor
'@workflow/next': minor
'@workflow/nitro': minor
'@workflow/astro': minor
'@workflow/sveltekit': minor
---

Start a workflow straight from a Vercel Schedule. Set `myWorkflow.experimental_schedule = { cron: '0 2 * * *' }` next to a workflow and the build emits a static schedule for it, with no `vercel.json` entry: the compiler copies the literal into the manifest, and the builders validate it and write Build Output `config.json#schedules` (for Next.js, next to the flow route, for the Vercel Next.js builder to return). For a dynamic schedule, spread `scheduleTarget(workflow, payload)` from `workflow/api` into `Schedules.create()`; the payload is type-checked against the workflow's `ScheduledRun<Payload>` parameter. Either publishes to the workflow's schedule topic (`scheduleTopic(workflow)`), which the flow route consumes: it starts the workflow with the occurrence, keyed by its `executionId` so a redelivery never starts a second run.
