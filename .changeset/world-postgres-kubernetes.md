---
"@workflow/world-postgres": minor
---

Add Kubernetes support for runs pinned with `deploymentId`. `@workflow/world-postgres/kubernetes` exports:
- per-deployment backlog queries;
- HTTP endpoints for KEDA autoscaling (`createBacklogEndpoints`);
- pruning of drained versions' worker Deployments, with restore of missing ones (`pruneWorkers`, and the `workflow-postgres-prune` CLI);
- graceful shutdown and probes (`createLifecycle`).

A Helm chart in the package's `chart` directory deploys them together: a main Deployment, a worker Deployment and KEDA ScaledObject per version, kept across upgrades until that version's runs finish, a prune CronJob with its own RBAC, and optional migrations in an init container.
