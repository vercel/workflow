---
"@workflow/world-vercel": patch
"@workflow/web": patch
---

Add `vercelApiUrl` to the Vercel World config: the Vercel REST API base URL, `https://api.vercel.com` by default. Point it at an API proxy that authenticates requests itself, such as Vercel CLI's extension API proxy; `token` is then optional. The web UI takes it from `WORKFLOW_VERCEL_API_URL`.
