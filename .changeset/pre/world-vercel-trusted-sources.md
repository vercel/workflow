---
"@workflow/world-vercel": minor
---

Switch the workflow-server Deployment Protection bypass to OIDC Trusted Sources. The `VERCEL_WORKFLOW_SERVER_PROTECTION_BYPASS` env var is no longer used; the `x-vercel-trusted-oidc-idp-token` header is now sourced from `getVercelOidcToken()`.
