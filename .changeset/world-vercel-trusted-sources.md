---
"@workflow/world-vercel": minor
---

Switch the Deployment Protection bypass on outbound workflow-server requests to OIDC Trusted Sources. The previously-added `VERCEL_WORKFLOW_SERVER_PROTECTION_BYPASS` env var is replaced by `VERCEL_OIDC_TOKEN`, which is read by `@vercel/oidc`'s `getVercelOidcToken()` and forwarded as `x-vercel-trusted-oidc-idp-token`. Also adds the `VERCEL_WORKFLOW_SERVER_URL` env var for configuring the workflow-server URL.
