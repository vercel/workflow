---
"@workflow/world-vercel": minor
"@workflow/builders": minor
"@workflow/next": minor
"@workflow/sveltekit": patch
---

Add opt-in `WORKFLOW_SEQUENTIAL_REPLAYS` env var (also enabled by the `WORKFLOW_SAFE_MODE=1` umbrella flag when not set explicitly). When set to `1`, flow (orchestrator) routes are limited to one invocation per run at a time via a per-run queue topic and `maxConcurrency: 1` on the flow trigger. Step routes are unaffected.
