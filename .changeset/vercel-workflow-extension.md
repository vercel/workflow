---
"workflow": patch
"@workflow/cli": patch
---

Install the Workflow CLI as a `vercel-workflow` bin too, so Vercel CLI runs it from the project's `node_modules` as `vercel workflow` (`vc workflow`). Run this way, `--backend` defaults to `vercel`, and Vercel API requests go through Vercel CLI's extension API proxy, which authenticates them with the Vercel CLI login.
