---
"@workflow/world": patch
"@workflow/core": patch
"@workflow/world-vercel": patch
---

Fix cross-deployment `start()` to 4.x deployments being misread as a run invocation, and keep replayed runs in the original run's region.
