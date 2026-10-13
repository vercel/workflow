---
"@workflow/core": minor
"@workflow/world-vercel": minor
---

On the Vercel World, store each webhook in its run's region: its hook ID is region-tagged, its generated token becomes `wh.<region>.<id>`, and `resumeWebhook()` reads the region back from the token. `createHook()` hooks are unchanged.
