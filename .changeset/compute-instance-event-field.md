---
'@workflow/core': minor
'@workflow/world': minor
'@workflow/world-vercel': minor
'@workflow/web-shared': minor
'@workflow/world-postgres': patch
---

Record the compute instance that ran each step attempt: `CreateEventParams.computeInstanceId` is stamped on `step_started` writes, forwarded in the world-vercel v4 frame meta alongside `vercelId`, and surfaced as "Compute Instance ID" in the observability attribute panel.
