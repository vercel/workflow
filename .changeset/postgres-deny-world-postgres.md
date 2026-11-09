---
"@workflow/world-postgres": minor
---

Deliver the Workflow SDK's messages in process, in a worker that runs only where the app registered its flow route (`registerWorkflowHandler()`, called by the framework startup hooks), and refuse the flow route over HTTP (`queueAuthMode: 'deny'`). Adopt the startup hook for your framework and drain processes on the previous release before upgrading; `@workflow/world-local` is no longer a dependency.
