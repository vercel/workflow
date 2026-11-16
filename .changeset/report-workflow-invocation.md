---
"@workflow/core": patch
---

Every orchestrator delivery, in the flow route or inline in the calling route, reports its run to the hosting runtime when the runtime offers a hook for it. On Vercel, the platform uses it to count the invocation as Workflow work in usage reporting and to tag the request's logs with the run ID, so a run's logs include an inline delivery. Elsewhere it does nothing.
