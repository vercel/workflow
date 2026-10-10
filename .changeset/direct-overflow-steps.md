---
"@workflow/world-vercel": patch
---

Deliver owner-managed overflow steps (`executionMode: 'remote'`) automatically: `queue()` POSTs each one with workload OIDC and no affinity to the deployment's generated `/.well-known/workflow/v1/step` route, instead of refusing them.
