---
"@workflow/world-postgres": minor
---

The worker runs wherever the Workflow SDK's flow handler is registered, also when the route was built with a different `WORKFLOW_QUEUE_NAMESPACE` than the World's `namespace` option; the World then warns once, naming both prefixes.
