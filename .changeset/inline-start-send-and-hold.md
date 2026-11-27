---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
"@workflow/next": patch
"@workflow/nitro": patch
---

`start()` and `resumeHook()` run the run's orchestrator delivery in the calling route, through the queue's send-and-hold, instead of a queue hop to the flow route, on a World that declares `capabilities.experimental_queueHold` (Vercel), for a run of this deployment and region. `withWorkflow()` (Next.js) and Nitro v3 production builds make the generated flow entry loadable from every server route through `@workflow/core/inline-entry`; other integrations queue as before. Every other case falls back to the queue. `WORKFLOW_INLINE_DELIVERY=0` turns it off. A held message's events carry the calling request's ID.
