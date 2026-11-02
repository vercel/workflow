---
"@workflow/world-vercel": patch
---

Stop following HTTP redirects on workflow API requests. `fetch` strips `Authorization` across origins but forwards every other header, so a redirect carried the request's `x-vercel-trusted-oidc-idp-token` to the host named in `Location`. A 3xx now surfaces as an error, matching the node:http transport.
