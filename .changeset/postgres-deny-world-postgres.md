---
"@workflow/world-postgres": minor
---

Deliver the Workflow SDK's messages in process, in a worker that runs in the process that called `world.start()`, and refuse the flow route over HTTP (`queueAuthMode: 'deny'`). `start()` gets the route by sending one health check to the app's own flow route, which hands itself to the World when it answers; the check runs in the background and is retried until the server answers, for up to two minutes. Upgrade `workflow` to the same release (now a peer dependency: an earlier runtime does not hand over its route, so no worker would start) and drain processes on the previous release before upgrading; `@workflow/world-local` is no longer a dependency. A runner start that fails after registration is retried with a backoff, and a delivery abandoned while it waited for its run is not run late.
