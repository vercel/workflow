---
"@workflow/core": minor
"workflow": minor
---

Add `queueAuthMode: 'deny'` to the flow route: on a World that delivers in process (the Postgres World), every HTTP request to `POST /.well-known/workflow/v1/flow` is refused with a `403` and `"code": "QUEUE_ROUTE_DENIED"` before any run is touched, counted on `workflow.queue.delivery.refused` with `workflow.queue.refusal_reason: denied`, and logged with what to do (drain old workers before upgrading; `WORKFLOW_QUEUE_AUTH=off` as an emergency override, refused while dynamic workflows are enabled). The route built by `workflowEntrypoint()` carries an in-process entry (`IN_PROCESS_QUEUE_HANDLER`) that takes the message and its metadata directly; its `workflow.route.flow` span is `INTERNAL` with `workflow.route.transport: 'in-process'` and the delivery's queue name, message id and attempt. Add `registerWorkflowHandler(route, { namespace, reloads })` and `refreshWorkflowHandler()` to `workflow/runtime`: the framework integrations hand the app's flow route to such a World when the app starts.
