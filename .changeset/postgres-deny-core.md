---
"@workflow/core": minor
"workflow": minor
---

Add `queueAuthMode: 'deny'`: the flow route of a World that delivers in process refuses every HTTP delivery with a `403` (the `?__health` probe still answers) and `"code": "QUEUE_ROUTE_DENIED"`, with `WORKFLOW_QUEUE_AUTH=off` as the emergency override. The route built by `workflowEntrypoint()` carries an in-process entry, whose `workflow.route.flow` span is the root of each delivery's trace, and hands itself to such a World when it answers the health check that World's `start()` sends; a route rebuilt in development replaces the one the World holds. Add `registerWorkflowHandler()` to `workflow/runtime`, for a process that runs the route without serving it over HTTP.
