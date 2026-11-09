---
"@workflow/core": minor
"workflow": minor
---

Add `queueAuthMode: 'deny'`: the flow route of a World that delivers in process (the Postgres World) refuses every HTTP request with a `403` and `"code": "QUEUE_ROUTE_DENIED"`, counted with `workflow.queue.refusal_reason: denied`; `WORKFLOW_QUEUE_AUTH=off` is the emergency override, refused while dynamic workflows are enabled. Add `registerWorkflowHandler()` and `refreshWorkflowHandler()` to `workflow/runtime`, and an in-process entry on the route built by `workflowEntrypoint()` whose `workflow.route.flow` span is `INTERNAL` with `workflow.route.transport: 'in-process'`.
