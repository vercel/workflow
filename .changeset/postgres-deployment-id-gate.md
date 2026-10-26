---
"@workflow/world-postgres": patch
---

Add experimental deployment routing: with `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING=1` (or `createWorld({ deploymentId })`), a process runs as the `WORKFLOW_DEPLOYMENT_ID` deployment and declares deployment affinity. Every process now sends each job to its addressed deployment's tasks and re-enqueues only its own deployment's active runs on startup.
