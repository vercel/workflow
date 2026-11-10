---
"@workflow/core": patch
"@workflow/next": patch
"workflow": patch
---

Experimental: `start(workflow, args, { experimental_inline: true })` and `resumeHook(token, payload, { experimental_inline: true })` run the run's orchestrator delivery in the calling route, through the queue's send-and-hold, instead of a queue hop to the flow route. Takes effect only on a World that declares `capabilities.experimental_queueHold`, for a run of this deployment and region, in a route that imports the flow entry (`import 'workflow/next/inline'` with `withWorkflow()`); otherwise the run is queued as usual. `WORKFLOW_EXPERIMENTAL_INLINE=0` turns it off.
