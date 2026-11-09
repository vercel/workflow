---
"@workflow/world-postgres": minor
---

Deliver the Workflow SDK's messages in process and refuse the flow route over HTTP (`queueAuthMode: 'deny'`): a worker runs only in a process that registered the app's flow route with `registerWorkflowHandler()`, which the framework startup hooks call, and every other process (the CLI, the web UI, a script) only enqueues. Adopt the startup hook the Postgres docs describe for your framework, deploy a copy of the app as a worker tier, and drain processes on the previous release before upgrading (or set `WORKFLOW_QUEUE_AUTH=off` for the overlap); `@workflow/world-local` is no longer a dependency.
