---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-vercel': minor
---

Record the compute instance that ran each step attempt: `CreateEventParams.computeInstanceId` is stamped on `step_started` writes and forwarded in the world-vercel v4 frame meta alongside `vercelId`.
