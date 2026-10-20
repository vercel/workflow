---
"@workflow/world-postgres": patch
---

Add experimental deployment routing: with `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING=1` (or `createWorld({ deploymentId })`), a process reports `WORKFLOW_DEPLOYMENT_ID`, consumes only its own `workflow_flows@<id>` tasks, and declares deployment affinity. Without it, the World remains the single `postgres` deployment.
