---
'@workflow/world-vercel': patch
---

Bound HTTP requests with a 30s headers/body timeout instead of undici's 5-minute default, and retry transport timeouts and other transient failures in-process, so a stalled connection no longer leaves a run silently paused for ~5 minutes until the queue redelivers it. Override with `WORKFLOW_VERCEL_HEADERS_TIMEOUT_MS` / `WORKFLOW_VERCEL_BODY_TIMEOUT_MS`.
