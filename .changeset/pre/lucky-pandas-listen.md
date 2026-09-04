---
'@workflow/world-vercel': patch
---

Authenticate `deploymentId: "latest"` with the deployment's own OIDC identity instead of an ambient `VERCEL_TOKEN`, and scope the request to the configured team, fixing spurious 404s when resolving the latest deployment
