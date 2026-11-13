---
"@workflow/world-postgres": minor
---

Add `deploymentId` (`WORKFLOW_POSTGRES_DEPLOYMENT_ID`), which pins every run to the deployment that started it. Each deployment claims and recovers only its own runs, a message for another deployment's run (such as a hook resumed from a newer deployment) is routed to that deployment's jobs, `getDeploymentId()` returns it, and the World declares deployment affinity. Runs started without it stay on the unpinned task, which a process without `deploymentId` claims.
