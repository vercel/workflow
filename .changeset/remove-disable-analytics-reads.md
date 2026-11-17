---
'@workflow/world-vercel': patch
---

Remove the `WORKFLOW_DISABLE_ANALYTICS_READS` environment variable. The `analytics` read namespace is always available; tests and tooling that need read-your-writes listings should read through the Storage API (`world.runs`, `world.steps`, `world.events`) instead.
