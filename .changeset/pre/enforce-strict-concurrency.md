---
"@workflow/world-vercel": minor
"@workflow/builders": minor
"@workflow/next": minor
"@workflow/sveltekit": patch
---

Add opt-in `WORKFLOW_SEQUENTIAL_REPLAYS` env var. When set to `1`, flow (orchestrator) routes are limited to one invocation per run at a time via a per-run queue topic and `maxConcurrency: 1` on the flow trigger. Step routes are unaffected. Routing each run through a dedicated `maxConcurrency: 1` topic might lead to higher queue performance overhead.
