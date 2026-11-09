---
"@workflow/core": minor
"workflow": minor
---

Add `queueAuthMode: 'deny'`: the flow route of a World that delivers in process refuses every HTTP request with a `403` and `"code": "QUEUE_ROUTE_DENIED"`, with `WORKFLOW_QUEUE_AUTH=off` as the emergency override. Add `registerWorkflowHandler()` and `refreshWorkflowHandler()` to `workflow/runtime`, and an in-process entry on the route built by `workflowEntrypoint()`, whose `workflow.route.flow` span is the root of each delivery's trace.
