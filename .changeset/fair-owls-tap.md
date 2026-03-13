---
"@workflow/world-vercel": patch
---

Reorder token resolution in `fetchRunKey` and `resolveLatestDeploymentId` to prefer `options.token` / `VERCEL_TOKEN` before calling OIDC, skipping the OIDC network call when a token is already available
