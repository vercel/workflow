---
"@workflow/world-postgres": minor
---

Add Kubernetes support for runs pinned to a `deploymentId`. Features per-deployment backlog queries, KEDA autoscaling, pruning of drained versions' worker Deployments. See Helm chart in the package's `chart` directory. Works by deploying app pods and a separate worker Deployment and KEDA ScaledObject per version, kept across upgrades until that version's runs finish.
