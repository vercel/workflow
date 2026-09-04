---
'@workflow/utils': patch
'@workflow/next': patch
---

Select the Vercel World for builds that target Vercel without a deployment ID, such as `vercel build` followed by `vercel deploy --prebuilt`, and apply `workflows.local.port` whenever the Local World is the target.
